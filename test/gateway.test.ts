import { describe, expect, it, vi } from "vitest";
import { PROVIDERS, sameSecret, serveGateway, type ModelRoute } from "../src/gateway";

const TOKEN = "instance-token-0123456789";
const route: ModelRoute = { provider: "anthropic", model: "claude-sonnet-4-6" };
const keys = { ANTHROPIC_API_KEY: "sk-ant-real" };

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token !== undefined) headers.set("authorization", `Bearer ${init.token}`);
  return new Request(`http://vims.gateway${path}`, { ...init, headers });
}

describe("the model gateway", () => {
  it("forwards to the instance's provider with the Worker's key, the instance's model, and streams back", async () => {
    const upstream = vi.fn(async (_r: Request) => new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } }));
    const res = await serveGateway(
      call("/v1/chat/completions?x=1", { method: "POST", token: TOKEN, headers: { "content-type": "application/json", cookie: "leak" }, body: JSON.stringify({ model: "gpt-6-astra", stream: true, messages: [] }) }),
      TOKEN, route, keys, upstream,
    );
    expect(await res.text()).toBe("data: ok\n\n");
    const sent = upstream.mock.calls[0]![0];
    expect(sent.url).toBe(`${PROVIDERS.anthropic.base}/chat/completions?x=1`);
    expect(sent.headers.get("authorization")).toBe("Bearer sk-ant-real");
    expect(sent.headers.get("cookie")).toBeNull();
    expect(JSON.parse(await sent.text())).toEqual({ model: "claude-sonnet-4-6", stream: true, messages: [] });
  });

  it("refuses a wrong or missing instance token without calling the provider", async () => {
    const upstream = vi.fn();
    for (const token of [undefined, "", "wrong-token-0123456789"]) {
      const res = await serveGateway(call("/v1/chat/completions", { method: "POST", ...(token !== undefined ? { token } : {}) }), TOKEN, route, keys, upstream);
      expect(res.status).toBe(401);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it("lists the instance's one model", async () => {
    const res = await serveGateway(call("/v1/models", { token: TOKEN }), TOKEN, route, keys);
    expect(await res.json()).toEqual({ object: "list", data: [{ id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" }] });
  });

  it("says which key is missing", async () => {
    const res = await serveGateway(call("/v1/chat/completions", { method: "POST", token: TOKEN }), TOKEN, { provider: "openrouter", model: "x/y" }, keys);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/no openrouter key \(OPENROUTER_API_KEY\)/);
  });

  it("serves only /v1 and rejects broken JSON", async () => {
    expect((await serveGateway(call("/admin", { token: TOKEN }), TOKEN, route, keys)).status).toBe(404);
    const bad = await serveGateway(call("/v1/chat/completions", { method: "POST", token: TOKEN, headers: { "content-type": "application/json" }, body: "{" }), TOKEN, route, keys, vi.fn());
    expect(bad.status).toBe(400);
  });

  it("OpenRouter calls carry VIMS attribution", async () => {
    const upstream = vi.fn(async (_r: Request) => new Response("{}"));
    await serveGateway(call("/v1/chat/completions", { method: "POST", token: TOKEN, headers: { "content-type": "application/json" }, body: "{}" }), TOKEN, { provider: "openrouter", model: "a/b" }, { OPENROUTER_API_KEY: "k" }, upstream);
    expect(upstream.mock.calls[0]![0].headers.get("x-title")).toBe("VIMS");
  });

  it("compares secrets in constant time and never matches empty", async () => {
    expect(await sameSecret("abc", "abc")).toBe(true);
    expect(await sameSecret("abc", "abd")).toBe(false);
    expect(await sameSecret("", "")).toBe(false);
  });
});
