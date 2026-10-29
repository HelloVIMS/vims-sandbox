// vims-sandbox: VIMS agent instances on Cloudflare Containers.
//
// Each VIMS instance is one Durable Object (named by its instance id) that
// starts its own container — a microVM with its own kernel and network — from
// the runtime's image. Internet is off; every HTTP/HTTPS request the container
// makes goes to the Outbound entrypoint, which serves the VIMS model gateway
// at http://vims.gateway (provider keys stay in the Worker) and applies the
// instance's VIMS egress policy to everything else.
//
// API (X-Vims-Sandbox-Token: <SANDBOX_TOKEN> on every /v1 request):
//   GET    /health                          public: version + runtimes
//   PUT    /v1/instances/:id                start (idempotent for the same spec)
//   GET    /v1/instances/:id                status { running, ready, ... }
//   PATCH  /v1/instances/:id                live update: egress, model (no restart)
//   DELETE /v1/instances/:id                stop and forget
//   GET    /v1/instances/:id/logs?lines=N   the runtime's recent output
//   *      /v1/instances/:id/http/<path>    the runtime's own HTTP/WebSocket API
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { GATEWAY_HOST, sameSecret, serveGateway, type ModelRoute } from "./gateway";
import { evaluate, type EgressPolicy } from "./policy";
import { RUNTIMES, RUNTIME_NAMES } from "./runtimes";
import { DEFAULT_TIMEOUT, INSTANCE_ID, parseLiveUpdate, parseSpec, specHash, type LiveUpdate, type StartSpec } from "./spec";
import { CA_PATH, RUNTIME_LOG, entrypointFor, fileEnv } from "./wrapper";

declare const __VIMS_SANDBOX_VERSION__: string;
const VERSION = typeof __VIMS_SANDBOX_VERSION__ === "string" ? __VIMS_SANDBOX_VERSION__ : "dev";

export interface Env {
  SANDBOX: DurableObjectNamespace<VimsSandbox>;
  /** VIMS authenticates to the Worker with it (X-Vims-Sandbox-Token). */
  SANDBOX_TOKEN?: string;
  [secret: string]: unknown;
}

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./index");
      durableNamespaces: "VimsSandbox";
    }
  }
}

const TOKEN_HEADER = "x-vims-sandbox-token";

/**
 * Headers the runtime must not see: the Worker's token, and the forwarding
 * headers Cloudflare's edge adds. The caller is VIMS and the Worker is the
 * only hop, so there is no client to attribute; runtimes that trust no proxy
 * (OpenClaw) refuse a request that claims one.
 */
function stripForRuntime(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    const n = name.toLowerCase();
    if (n === TOKEN_HEADER || n === "forwarded" || n === "x-real-ip" || n === "true-client-ip" || n === "cdn-loop" || n.startsWith("x-forwarded-") || n.startsWith("cf-")) {
      headers.delete(name);
    }
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface OutboundProps {
  instanceId: string;
  gatewayToken: string;
  model: ModelRoute;
  egress: EgressPolicy;
}

/** Every HTTP and HTTPS request a sandbox container makes. */
export class Outbound extends WorkerEntrypoint<Env, OutboundProps> {
  override async fetch(request: Request): Promise<Response> {
    const p = this.ctx.props;
    const url = new URL(request.url);
    if (url.hostname === GATEWAY_HOST) return serveGateway(request, p.gatewayToken, p.model, this.env);
    const verdict = evaluate(p.egress, url.hostname, request.method, url.pathname);
    if (!verdict.allowed) {
      console.log(`[egress] ${p.instanceId} DENY ${request.method} ${url.hostname}${url.pathname} (${verdict.reason})`);
      return new Response(`blocked by this agent's VIMS egress policy: ${request.method} ${url.hostname} (${verdict.reason})\n`, { status: 403 });
    }
    return fetch(request);
  }
}

// A cold container on a small instance can take minutes before the runtime
// listens (OpenClaw: ~2-4 min on standard-1); a request that wakes a
// stopped container waits as long as VIMS waits for a start.
const READY_TIMEOUT_MS = 300_000;

/** One VIMS instance: its container, spec and lifecycle. */
export class VimsSandbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // After a deploy or eviction the container may still run: its
    // intercepts persist, but the inactivity timeout and the intercepts'
    // code (props, Outbound version) must be set again.
    const c = ctx.container;
    const spec = this.spec();
    if (c?.running && spec) void ctx.blockConcurrencyWhile(() => this.configure(spec));
  }

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("this Durable Object has no container configured");
    return c;
  }

  private spec(): StartSpec | undefined {
    return this.ctx.storage.kv.get<StartSpec>("spec");
  }

  private async configure(spec: StartSpec): Promise<void> {
    const outbound = this.ctx.exports.Outbound({
      props: { instanceId: spec.instanceId, gatewayToken: spec.gatewayToken, model: spec.model, egress: spec.egress },
    });
    await this.container.interceptAllOutboundHttp(outbound);
    await this.container.interceptOutboundHttps("*", outbound);
    await this.container.setInactivityTimeout(spec.inactivityTimeoutMs || DEFAULT_TIMEOUT);
  }

  private async launch(spec: StartSpec): Promise<void> {
    const rt = RUNTIMES[spec.runtime];
    const image = this.container.images[spec.runtime];
    if (!rt || !image) throw new Error(`runtime ${spec.runtime} has no image in this deploy`);
    if (!rt.shell && (spec.files.length || spec.dirs.length)) throw new Error(`${spec.runtime}'s image has no shell, so it takes configuration from env only`);
    const command = [...rt.entrypoint, ...(spec.args ?? rt.cmd)];
    this.container.start({
      image,
      instance: spec.instance,
      enableInternet: false,
      entrypoint: entrypointFor(rt.shell, command),
      env: {
        ...spec.env,
        ...fileEnv(spec.files, spec.dirs),
        NODE_EXTRA_CA_CERTS: CA_PATH,
        SSL_CERT_FILE: CA_PATH,
        REQUESTS_CA_BUNDLE: CA_PATH,
        VIMS_SANDBOX: "cloudflare",
        // Every connection goes to the Outbound policy and DNS answers are
        // placeholders: runtimes' own private-address guards can stand down.
        VIMS_EGRESS_MEDIATED: "1",
        VIMS_INSTANCE_ID: spec.instanceId,
      },
      labels: { runtime: spec.runtime, vims: spec.instanceId.slice(0, 64) },
    });
    try {
      await this.configure(spec);
      this.ctx.storage.kv.put("startedAt", Date.now());
      this.ctx.storage.kv.put("runningSpec", await specHash(spec));
      this.ctx.storage.kv.delete("lastExit");
      this.container.monitor().then(
        () => this.ctx.storage.kv.put("lastExit", { at: Date.now(), error: null }),
        (e: unknown) => this.ctx.storage.kv.put("lastExit", { at: Date.now(), error: String(e) }),
      );
    } catch (e) {
      await this.container.destroy(e);
      throw e;
    }
  }

  /** The runtime answers on its port (any HTTP response counts). */
  private async ready(port: number): Promise<boolean> {
    if (!this.container.running) return false;
    try {
      await this.container.getTcpPort(port).fetch("http://container/", { signal: AbortSignal.timeout(3000) });
      return true;
    } catch {
      return false;
    }
  }

  private async waitReady(port: number): Promise<boolean> {
    const until = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < until) {
      if (await this.ready(port)) return true;
      if (!this.container.running) return false;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  async start(spec: StartSpec): Promise<Record<string, unknown>> {
    this.ctx.storage.kv.put("spec", spec);
    if (this.container.running) {
      if (this.ctx.storage.kv.get("runningSpec") === (await specHash(spec))) {
        await this.configure(spec);
        return this.status();
      }
      await this.container.destroy("restarting with a new spec");
    }
    await this.launch(spec);
    return this.status();
  }

  /**
   * Applies a new egress policy or model to the instance's saved spec and,
   * if its container runs, to the container's intercepts at once — the
   * intercepts carry them as props, and registering again replaces the
   * handler without dropping open connections. No restart, no lost disk.
   */
  async update(patch: LiveUpdate): Promise<Record<string, unknown>> {
    const spec = this.spec();
    if (!spec) throw new Error("instance not started");
    const wasCurrent = this.ctx.storage.kv.get("runningSpec") === (await specHash(spec));
    const next: StartSpec = { ...spec, ...(patch.egress ? { egress: patch.egress } : {}), ...(patch.model ? { model: patch.model } : {}) };
    this.ctx.storage.kv.put("spec", next);
    if (this.container.running && wasCurrent) {
      await this.configure(next);
      this.ctx.storage.kv.put("runningSpec", await specHash(next));
    }
    return this.status();
  }

  async status(): Promise<Record<string, unknown>> {
    const spec = this.spec();
    const running = this.container.running;
    return {
      running,
      ready: spec ? await this.ready(spec.port) : false,
      runtime: spec?.runtime ?? null,
      model: spec?.model ?? null,
      startedAt: this.ctx.storage.kv.get("startedAt") ?? null,
      lastExit: this.ctx.storage.kv.get("lastExit") ?? null,
    };
  }

  async stop(): Promise<void> {
    this.ctx.storage.kv.delete("spec");
    this.ctx.storage.kv.delete("runningSpec");
    if (this.container.running) await this.container.destroy("stopped by VIMS");
  }

  async logs(lines: number): Promise<string> {
    const spec = this.spec();
    const rt = spec ? RUNTIMES[spec.runtime] : undefined;
    if (!spec || !rt) return "";
    if (!rt.shell) {
      return `${spec.runtime}'s image has no shell, so its output is not kept in the container; see the Worker's logs (Cloudflare dashboard → Workers & Pages → vims-sandbox → Logs).\n`;
    }
    if (!this.container.running) return "";
    const proc = await this.container.exec([rt.shell, "-c", `tail -n ${Math.max(1, Math.min(lines, 5000))} ${RUNTIME_LOG} 2>/dev/null || true`]);
    const out = await proc.output();
    return new TextDecoder().decode(out.stdout);
  }

  /** The runtime's own API; a stopped container with a saved spec is woken. */
  override async fetch(request: Request): Promise<Response> {
    const spec = this.spec();
    if (!spec) return json(404, { error: "instance not started" });
    if (!this.container.running) await this.launch(spec);
    if (!(await this.waitReady(spec.port))) {
      return json(503, { error: `${spec.runtime} did not start listening on port ${spec.port}`, lastExit: this.ctx.storage.kv.get("lastExit") ?? null });
    }
    const url = new URL(request.url);
    return this.container.getTcpPort(spec.port).fetch(new Request(new Request(`http://container${url.pathname}${url.search}`, request), { redirect: "manual" }));
  }
}

function stub(env: Env, id: string) {
  return env.SANDBOX.get(env.SANDBOX.idFromName(id));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true, service: "vims-sandbox", version: VERSION, runtimes: RUNTIME_NAMES });
    if (!url.pathname.startsWith("/v1/")) return json(404, { error: "not found" });
    if (!env.SANDBOX_TOKEN) return json(503, { error: "SANDBOX_TOKEN is not set on this Worker" });
    if (!(await sameSecret(request.headers.get(TOKEN_HEADER) ?? "", env.SANDBOX_TOKEN))) return json(401, { error: "unauthorized" });

    const m = /^\/v1\/instances\/([^/]+)(\/logs|\/http(\/.*)?)?$/.exec(url.pathname);
    const id = m?.[1] ? decodeURIComponent(m[1]) : "";
    if (!m || !INSTANCE_ID.test(id)) return json(404, { error: "not found" });
    const sandbox = stub(env, id);

    try {
      if (m[2] === "/logs") {
        if (request.method !== "GET") return json(405, { error: "method not allowed" });
        const lines = Number(url.searchParams.get("lines") ?? "200");
        return new Response(await sandbox.logs(Number.isFinite(lines) ? lines : 200), { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (m[2]?.startsWith("/http")) {
        // Same method, body and headers (the runtime's own Authorization
        // included), minus the Worker's token and the edge's forwarding
        // headers; redirects go back to VIMS.
        const inner = new Request(new Request(`http://instance${m[3] ?? "/"}${url.search}`, request), { redirect: "manual" });
        stripForRuntime(inner.headers);
        return sandbox.fetch(inner);
      }
      switch (request.method) {
        case "PUT": {
          const spec = parseSpec(id, await request.json().catch(() => null), RUNTIME_NAMES);
          if (typeof spec === "string") return json(400, { error: spec });
          return json(200, await sandbox.start(spec));
        }
        case "GET":
          return json(200, await sandbox.status());
        case "PATCH": {
          const patch = parseLiveUpdate(await request.json().catch(() => null));
          if (typeof patch === "string") return json(400, { error: patch });
          return json(200, await sandbox.update(patch));
        }
        case "DELETE":
          await sandbox.stop();
          return json(200, { stopped: true });
        default:
          return json(405, { error: "method not allowed" });
      }
    } catch (e) {
      console.error(`[vims-sandbox] ${request.method} ${url.pathname}:`, e);
      return json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  },
} satisfies ExportedHandler<Env>;
