import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpec, specHash } from "../src/spec";
import { CA_PATH, WRAPPER_SCRIPT, entrypointFor, fileEnv } from "../src/wrapper";

const good = {
  runtime: "openclaw",
  port: 18789,
  env: { OPENCLAW_PORT: "18789" },
  files: [{ path: "/home/node/.openclaw/openclaw.json", contentBase64: btoa('{"a":1}') }],
  egress: { default: "deny", rules: [{ host: "*.gov" }] },
  model: { provider: "openai", model: "gpt-5.4" },
  gatewayToken: "vims-instance-token-0123",
};

describe("start specs", () => {
  it("accepts a well-formed spec with defaults", () => {
    const s = parseSpec("oc-abc_1", good, ["openclaw", "zeroclaw"]);
    expect(typeof s).toBe("object");
    expect(s).toMatchObject({ instanceId: "oc-abc_1", instance: "standard-1", inactivityTimeoutMs: 7_200_000 });
  });

  it("names the first problem", () => {
    const bad = (patch: Record<string, unknown>, id = "oc-1") => parseSpec(id, { ...good, ...patch }, ["openclaw"]);
    expect(parseSpec("../x", good, ["openclaw"])).toMatch(/instance id/);
    expect(bad({ runtime: "hermes" })).toMatch(/runtime must be one of: openclaw/);
    expect(bad({ port: 0 })).toMatch(/port/);
    expect(bad({ env: { "BAD-NAME": "x" } })).toMatch(/bad env name/);
    expect(bad({ env: { VIMS_FILE_0_PATH: "/x" } })).toMatch(/bad env name/);
    expect(bad({ model: { provider: "vims", model: "local" } })).toMatch(/provider the sandbox gateway serves/);
    expect(bad({ gatewayToken: "short" })).toMatch(/gatewayToken/);
    expect(bad({ instance: "huge" })).toMatch(/instance must be/);
    expect(bad({ inactivityTimeoutMs: 1000 })).toMatch(/between 1 minute and 6 hours/);
    expect(bad({ egress: { rules: [{ host: "" }] } })).toMatch(/egress/);
    expect(bad({ dirs: "/data" })).toMatch(/dirs must be a list/);
  });

  it("fingerprints identical specs identically and different ones differently", async () => {
    const a = parseSpec("i1", good, ["openclaw"]);
    const b = parseSpec("i1", good, ["openclaw"]);
    const c = parseSpec("i1", { ...good, env: { OPENCLAW_PORT: "1" } }, ["openclaw"]);
    if (typeof a === "string" || typeof b === "string" || typeof c === "string") throw new Error("parse");
    expect(await specHash(a)).toBe(await specHash(b));
    expect(await specHash(a)).not.toBe(await specHash(c));
  });
});

describe("the entrypoint wrapper", () => {
  it("refuses unsafe seed files", () => {
    expect(() => fileEnv([{ path: "relative", contentBase64: "" }])).toThrow(/absolute/);
    expect(() => fileEnv([{ path: "/a/../etc/passwd", contentBase64: "" }])).toThrow(/absolute/);
    expect(() => fileEnv([{ path: "/ok", contentBase64: "not base64!" }])).toThrow(/base64/);
    expect(() => fileEnv([], ["/data/../etc"])).toThrow(/directory/);
    expect(() => fileEnv([], ["/a:b"])).toThrow(/directory/);
    expect(fileEnv([], ["/data/home", "/data/tmp"])).toEqual({ VIMS_MKDIRS: "/data/home:/data/tmp" });
  });

  it("wraps only images with a shell", () => {
    expect(entrypointFor(null, ["zeroclaw", "daemon"])).toEqual(["zeroclaw", "daemon"]);
    expect(entrypointFor("/bin/sh", ["node", "x"]).slice(0, 2)).toEqual(["/bin/sh", "-c"]);
  });

  it("really writes the seed files, waits for the CA, execs the runtime and keeps its output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vims-wrapper-"));
    const ca = path.join(dir, "ca.crt");
    fs.writeFileSync(ca, "CA");
    // Same script, with the container paths moved into the temp dir.
    const script = WRAPPER_SCRIPT.split(CA_PATH).join(ca).split("/tmp/vims-runtime").join(path.join(dir, "runtime"));
    const target = path.join(dir, "deep", "cfg.json");
    const made = path.join(dir, "data", "home");
    const env = { PATH: process.env.PATH ?? "", ...fileEnv([{ path: target, contentBase64: Buffer.from('{"x":"y z"}').toString("base64") }], [made, path.join(dir, "data", "tmp")]) };
    const out = execFileSync("/bin/sh", ["-c", script, "vims-sandbox", "/bin/sh", "-c", 'cat "$0"; echo; env | grep -c VIMS_ || true', target], { env, encoding: "utf8" });
    expect(fs.statSync(made).isDirectory() && fs.statSync(path.join(dir, "data", "tmp")).isDirectory()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe('{"x":"y z"}');
    // The runtime sees the file and no leftover VIMS_FILE_* variables; its
    // output reaches both the container's stdout (Workers logs) and the log
    // the logs endpoint tails.
    expect(out).toBe('{"x":"y z"}\n0\n');
    expect(fs.readFileSync(path.join(dir, "runtime.log"), "utf8")).toBe(out);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
