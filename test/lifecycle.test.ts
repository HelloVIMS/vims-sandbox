import { describe, expect, it, vi } from "vitest";
import { VimsSandbox, type Env } from "../src/index";
import { parseSpec, specHash, type StartSpec } from "../src/spec";
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function spec(env: Record<string, string> = { A: "1", B: "2" }): StartSpec {
  const parsed = parseSpec("agent-1", {
    runtime: "hermes", port: 8080, env,
    model: { provider: "openai", model: "test-model" },
    gatewayToken: "test-gateway-token-123456",
  }, ["hermes"]);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}
async function oldHash(value: StartSpec) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fixture(saved?: StartSpec, fingerprint?: string, initiallyRunning = false) {
  const values = new Map<string, unknown>();
  if (saved) values.set("spec", structuredClone(saved));
  if (fingerprint) values.set("runningSpec", fingerprint);
  const exits: ReturnType<typeof deferred>[] = [];
  let running = initiallyRunning;
  const container = {
    images: { hermes: "test-image" },
    get running() { return running; },
    start: vi.fn(() => { running = true; }),
    destroy: vi.fn(async () => { running = false; }),
    interceptAllOutboundHttp: vi.fn(async () => {}),
    interceptOutboundHttps: vi.fn(async () => {}),
    setInactivityTimeout: vi.fn(async () => {}),
    monitor: vi.fn(() => { const exit = deferred(); exits.push(exit); return exit.promise; }),
    getTcpPort: vi.fn(() => ({ fetch: vi.fn(async () => new Response("ready")) })),
  };
  const ctx = {
    container,
    storage: { kv: {
      get: (key: string) => structuredClone(values.get(key)),
      put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
      delete: (key: string) => values.delete(key),
    } },
    exports: { Outbound: (options: unknown) => options },
    blockConcurrencyWhile: (action: () => Promise<void>) => action(),
  } as unknown as DurableObjectState;
  return { sandbox: new VimsSandbox(ctx, {} as Env), container, values, exits };
}
describe("stable spec fingerprints", () => {
  it("ignores object insertion order, including nested egress rules", async () => {
    const a = spec({ A: "1", B: "2" });
    const b = spec({ B: "2", A: "1" });
    a.egress = { default: "deny", rules: [{ host: "example.com", action: "allow", methods: ["GET"] }] };
    b.egress = { rules: [{ methods: ["GET"], action: "allow", host: "example.com" }], default: "deny" };
    expect(await specHash(a)).toBe(await specHash(b));
  });
  it("preserves order-sensitive arrays and distinguishes changed values", async () => {
    const a = spec();
    a.args = ["one", "two"];
    expect(await specHash(a)).not.toBe(await specHash({ ...a, args: ["two", "one"] }));
    expect(await specHash(a)).not.toBe(await specHash({ ...a, env: { A: "changed", B: "2" } }));
    const rules = [{ host: "example.com", action: "deny" as const }, { host: "*", action: "allow" as const }];
    expect(await specHash({ ...a, egress: { default: "deny", rules } })).not.toBe(
      await specHash({ ...a, egress: { default: "deny", rules: [...rules].reverse() } }),
    );
  });
});
describe("serialized container lifecycle", () => {
  it("launches once for concurrent identical starts", async () => {
    const f = fixture();
    await Promise.all([f.sandbox.start(spec()), f.sandbox.start(spec())]);
    expect(f.container.start).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).not.toHaveBeenCalled();
  });
  it("does not restart when environment key order changes", async () => {
    const f = fixture();
    await f.sandbox.start(spec());
    await f.sandbox.start(spec({ B: "2", A: "1" }));
    expect(f.container.start).toHaveBeenCalledTimes(1);
    expect(f.container.destroy).not.toHaveBeenCalled();
  });
  it("migrates a legacy running fingerprint without a restart", async () => {
    const saved = spec();
    const f = fixture(saved, await oldHash(saved), true);
    const reordered = spec({ B: "2", A: "1" });
    await f.sandbox.start(reordered);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.container.destroy).not.toHaveBeenCalled();
    expect(f.values.get("runningSpec")).toBe(await specHash(reordered));
  });
  it("migrates a sleeping legacy instance without waking it on lazy PUT", async () => {
    const saved = spec();
    const f = fixture(saved, await oldHash(saved));
    await f.sandbox.start(spec({ B: "2", A: "1" }), true);
    expect(f.container.start).not.toHaveBeenCalled();
    expect(f.values.get("runningSpec")).toBe(await specHash(saved));
  });
  it("still restarts when the effective configuration changes", async () => {
    const f = fixture();
    await f.sandbox.start(spec());
    await f.sandbox.start(spec({ A: "changed" }));
    expect(f.container.start).toHaveBeenCalledTimes(2);
    expect(f.container.destroy).toHaveBeenCalledTimes(1);
  });
  it("does not let a queued stop be undone by an in-flight start", async () => {
    const f = fixture();
    const gate = deferred();
    f.container.setInactivityTimeout.mockImplementationOnce(() => gate.promise);
    const starting = f.sandbox.start(spec());
    await vi.waitFor(() => expect(f.container.setInactivityTimeout).toHaveBeenCalled());
    const stopping = f.sandbox.stop();
    gate.resolve();
    await Promise.all([starting, stopping]);
    expect(f.container.running).toBe(false);
    expect(f.values.has("spec")).toBe(false);
    expect(f.values.has("runningSpec")).toBe(false);
  });
  it("retains both concurrent live patches", async () => {
    const f = fixture();
    await f.sandbox.start(spec());
    await Promise.all([
      f.sandbox.update({ egress: { default: "allow", rules: [] } }),
      f.sandbox.update({ model: { provider: "openai", model: "replacement" } }),
    ]);
    expect(f.values.get("spec")).toMatchObject({
      egress: { default: "allow" }, model: { model: "replacement" },
    });
    expect(f.container.start).toHaveBeenCalledTimes(1);
  });
  it("ignores exit notifications from a superseded container", async () => {
    const f = fixture();
    await f.sandbox.start(spec());
    await f.sandbox.start(spec({ A: "new" }));
    f.exits[0]!.reject(new Error("old generation exited"));
    await Promise.resolve();
    expect(f.values.has("lastExit")).toBe(false);
    f.exits[1]!.resolve();
    await Promise.resolve();
    expect(f.values.get("lastExit")).toMatchObject({ error: null });
  });
  it("ignores old exit notifications after explicit stop", async () => {
    const f = fixture();
    await f.sandbox.start(spec());
    await f.sandbox.stop();
    f.exits[0]!.resolve();
    await Promise.resolve();
    expect(f.values.has("lastExit")).toBe(false);
  });
  it("does not poison subsequent lifecycle requests after a failure", async () => {
    const f = fixture();
    f.container.setInactivityTimeout.mockRejectedValueOnce(new Error("configuration failed"));
    await expect(f.sandbox.start(spec())).rejects.toThrow("configuration failed");
    await expect(f.sandbox.wake()).resolves.toMatchObject({ running: true });
    expect(f.container.start).toHaveBeenCalledTimes(2);
  });
  it("routes an automatic HTTP wake through the same lifecycle queue", async () => {
    const saved = spec();
    const f = fixture(saved, await specHash(saved));
    await Promise.all([
      f.sandbox.fetch(new Request("https://instance/test")),
      f.sandbox.wake(),
    ]);
    expect(f.container.start).toHaveBeenCalledTimes(1);
  });
});