import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";

const TOKEN = "sandbox-token-abcdefghijklmnop";

function fakeEnv(withToken = true) {
  const calls: { method: string; args: unknown[] }[] = [];
  const stub = {
    start: vi.fn(async (spec: unknown) => { calls.push({ method: "start", args: [spec] }); return { running: true }; }),
    status: vi.fn(async () => ({ running: false })),
    stop: vi.fn(async () => {}),
    update: vi.fn(async (p: unknown) => ({ running: true, applied: p })),
    wake: vi.fn(async () => ({ running: true, ready: false })),
    logs: vi.fn(async (n: number) => `last ${n}\n`),
    fetch: vi.fn(async (r: Request) => new Response(JSON.stringify({
      url: r.url,
      token: r.headers.get("x-vims-sandbox-token"),
      auth: r.headers.get("authorization"),
      forwarded: [...r.headers.keys()].filter((h) => h.startsWith("x-forwarded") || h.startsWith("cf-") || h === "x-real-ip" || h === "forwarded"),
    }))),
  };
  const ids: string[] = [];
  const env = {
    SANDBOX: { idFromName: (n: string) => { ids.push(n); return n; }, get: () => stub },
    ...(withToken ? { SANDBOX_TOKEN: TOKEN } : {}),
  } as unknown as Env;
  return { env, stub, ids, calls };
}

const req = (path: string, init: RequestInit = {}, token: string | null = TOKEN) => {
  const headers = new Headers(init.headers);
  if (token !== null) headers.set("x-vims-sandbox-token", token);
  return new Request(`https://vims-sandbox.example.workers.dev${path}`, { ...init, headers });
};

describe("the Worker API", () => {
  it("answers /health without a token, with its runtimes", async () => {
    const { env } = fakeEnv();
    const res = await worker.fetch(req("/health", {}, null), env);
    expect(await res.json()).toMatchObject({ ok: true, service: "vims-sandbox", runtimes: ["hermes", "nemoclaw", "openclaw", "openfang", "zeroclaw"] });
  });

  it("refuses every /v1 call without the right token, and all of them when none is set", async () => {
    const { env, stub } = fakeEnv();
    expect((await worker.fetch(req("/v1/instances/a", {}, null), env)).status).toBe(401);
    expect((await worker.fetch(req("/v1/instances/a", {}, "wrong"), env)).status).toBe(401);
    expect((await worker.fetch(req("/v1/instances/a/http/x", {}, "wrong"), env)).status).toBe(401);
    expect((await worker.fetch(req("/v1/instances/a"), fakeEnv(false).env)).status).toBe(503);
    expect(stub.status).not.toHaveBeenCalled();
    expect(stub.fetch).not.toHaveBeenCalled();
  });

  it("rejects ids that aren't instance ids", async () => {
    const { env } = fakeEnv();
    for (const p of ["/v1/instances/..%2Fx", "/v1/instances/a%20b", "/v1/other/a"]) {
      expect((await worker.fetch(req(p), env)).status).toBe(404);
    }
  });

  it("starts with a validated spec, one Durable Object per instance id", async () => {
    const { env, stub, ids } = fakeEnv();
    const bad = await worker.fetch(req("/v1/instances/oc-1", { method: "PUT", body: JSON.stringify({ runtime: "nope" }) }), env);
    expect(bad.status).toBe(400);
    expect(stub.start).not.toHaveBeenCalled();
    const spec = { runtime: "zeroclaw", port: 42617, env: {}, files: [], egress: { default: "deny", rules: [] }, model: { provider: "openai", model: "gpt-5.4" }, gatewayToken: "0123456789abcdef" };
    const ok = await worker.fetch(req("/v1/instances/oc-1", { method: "PUT", body: JSON.stringify(spec) }), env);
    expect(ok.status).toBe(200);
    expect(stub.start.mock.calls[0]![0]).toMatchObject({ instanceId: "oc-1", runtime: "zeroclaw" });
    expect(ids).toContain("oc-1");
  });

  it("proxies the runtime API without the sandbox token, keeping the runtime's own auth", async () => {
    const { env } = fakeEnv();
    const edge = { authorization: "Bearer instance-token", "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "x-real-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.9", forwarded: "for=203.0.113.9" };
    const res = await worker.fetch(req("/v1/instances/oc-1/http/v1/chat/completions?s=1", { method: "POST", headers: edge, body: "{}" }), env);
    const got = (await res.json()) as { url: string; token: string | null; auth: string; forwarded: string[] };
    expect(got).toEqual({ url: "http://instance/v1/chat/completions?s=1", token: null, auth: "Bearer instance-token", forwarded: [] });
  });

  it("applies a live egress/model update, validated", async () => {
    const { env, stub } = fakeEnv();
    const bad = await worker.fetch(req("/v1/instances/oc-1", { method: "PATCH", body: JSON.stringify({ model: { provider: "vims", model: "x" } }) }), env);
    expect(bad.status).toBe(400);
    expect((await worker.fetch(req("/v1/instances/oc-1", { method: "PATCH", body: "{}" }), env)).status).toBe(400);
    const ok = await worker.fetch(req("/v1/instances/oc-1", { method: "PATCH", body: JSON.stringify({ egress: { default: "deny", rules: [{ host: "*.gov" }] } }) }), env);
    expect(ok.status).toBe(200);
    expect(stub.update.mock.calls[0]![0]).toEqual({ egress: { default: "deny", rules: [{ host: "*.gov" }] } });
    expect((await worker.fetch(req("/v1/instances/oc-1", { method: "PATCH", body: "{}" }, "wrong"), env)).status).toBe(401);
  });

  it("wakes a stopped instance on POST only", async () => {
    const { env, stub } = fakeEnv();
    expect(await (await worker.fetch(req("/v1/instances/oc-1/wake", { method: "POST" }), env)).json()).toEqual({ running: true, ready: false });
    expect(stub.wake).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(req("/v1/instances/oc-1/wake"), env)).status).toBe(405);
  });

  it("stops, reports status and returns logs", async () => {
    const { env, stub } = fakeEnv();
    expect(await (await worker.fetch(req("/v1/instances/oc-1", { method: "DELETE" }), env)).json()).toEqual({ stopped: true });
    expect(stub.stop).toHaveBeenCalled();
    expect(await (await worker.fetch(req("/v1/instances/oc-1/logs?lines=5"), env)).text()).toBe("last 5\n");
    expect((await worker.fetch(req("/v1/instances/oc-1", { method: "POST" }), env)).status).toBe(405);
  });
});
