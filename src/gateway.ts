// The VIMS model gateway, inside the Worker. A runtime in the container calls
// an OpenAI-compatible API at http://vims.gateway/v1 with its instance token,
// exactly as it calls the VIMS sandbox gateway on a desktop. The Worker checks
// the token, names the instance's model (the shell's own model id never
// chooses a provider or spends a key), adds the provider key it holds as a
// secret, and streams the provider's answer back. The container never holds
// a provider key.

export const GATEWAY_HOST = "vims.gateway";

/** OpenAI-compatible endpoints, and the Worker secret holding each key. */
export const PROVIDERS = {
  anthropic: { base: "https://api.anthropic.com/v1", key: "ANTHROPIC_API_KEY" },
  openai: { base: "https://api.openai.com/v1", key: "OPENAI_API_KEY" },
  openrouter: { base: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY" },
  google: { base: "https://generativelanguage.googleapis.com/v1beta/openai", key: "GEMINI_API_KEY" },
  xai: { base: "https://api.x.ai/v1", key: "XAI_API_KEY" },
  groq: { base: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY" },
  mistral: { base: "https://api.mistral.ai/v1", key: "MISTRAL_API_KEY" },
  deepseek: { base: "https://api.deepseek.com/v1", key: "DEEPSEEK_API_KEY" },
  moonshot: { base: "https://api.moonshot.ai/v1", key: "MOONSHOT_API_KEY" },
  nvidia: { base: "https://integrate.api.nvidia.com/v1", key: "NVIDIA_API_KEY" },
} as const;

export type Provider = keyof typeof PROVIDERS;

export const isProvider = (p: unknown): p is Provider => typeof p === "string" && Object.hasOwn(PROVIDERS, p);

/** The model an instance's calls go to (VIMS resolves it per instance). */
export interface ModelRoute {
  provider: Provider;
  model: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const openAIError = (status: number, message: string, type: string) => json(status, { error: { message, type } });

/** Constant-time string comparison: both sides are hashed to equal-length
 *  digests, which are compared without an early exit. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (m?.[1]) return m[1].trim();
  return (req.headers.get("x-api-key") ?? "").trim();
}

/**
 * Serve one gateway request for an instance. `keys` maps secret names to
 * values (the Worker env); `upstream` performs the provider call.
 */
export async function serveGateway(
  req: Request,
  instanceToken: string,
  route: ModelRoute,
  keys: Record<string, unknown>,
  upstream: (r: Request) => Promise<Response> = (r) => fetch(r),
): Promise<Response> {
  if (!(await sameSecret(bearer(req), instanceToken))) {
    return openAIError(401, "vims sandbox gateway: unknown or missing instance token", "invalid_request_error");
  }
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/v1/") && url.pathname !== "/v1") {
    return openAIError(404, `vims sandbox gateway serves /v1/* (asked for ${url.pathname})`, "invalid_request_error");
  }
  // The instance has exactly one model: list it, so runtimes that probe
  // /v1/models see what they will get.
  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(200, { object: "list", data: [{ id: route.model, object: "model", owned_by: route.provider }] });
  }
  const provider = PROVIDERS[route.provider];
  const key = keys[provider.key];
  if (typeof key !== "string" || !key) {
    return openAIError(503, `the sandbox has no ${route.provider} key (${provider.key}) — add it in VIMS → Agents → Cloudflare Sandbox`, "insufficient_quota");
  }

  const headers = new Headers();
  for (const name of ["content-type", "accept", "openai-beta"]) {
    const v = req.headers.get(name);
    if (v) headers.set(name, v);
  }
  headers.set("authorization", `Bearer ${key}`);
  if (route.provider === "openrouter") {
    headers.set("http-referer", "https://vims.com");
    headers.set("x-title", "VIMS");
  }

  let body: BodyInit | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const raw = await req.text();
    body = raw;
    if (raw && (req.headers.get("content-type") ?? "").includes("json")) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          parsed.model = route.model;
          body = JSON.stringify(parsed);
        }
      } catch {
        return openAIError(400, "vims sandbox gateway: request body is not valid JSON", "invalid_request_error");
      }
    }
  }
  const target = provider.base + url.pathname.slice("/v1".length) + url.search;
  return upstream(new Request(target, { method: req.method, headers, body }));
}
