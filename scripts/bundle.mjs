#!/usr/bin/env node
// Builds the bundle VIMS deploys through the Cloudflare API (no wrangler on
// the user's machine): the Worker as one ES module, plus a manifest naming
// its bindings, container class and the runtime images (from
// runtimes.lock.json) to copy into the account's registry.
//
//   node scripts/bundle.mjs <out-dir> [version]
//   → <out-dir>/manifest.json, <out-dir>/worker/index.js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const version = process.argv[3] ?? `vims-sandbox-${execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`;
const lock = JSON.parse(fs.readFileSync(path.join(root, "runtimes.lock.json"), "utf8"));

const DIGEST = /@sha256:[0-9a-f]{64}$/;
for (const [name, rt] of Object.entries(lock)) {
  if (!DIGEST.test(rt.source)) throw new Error(`runtimes.lock.json: ${name} is not digest-pinned`);
}

fs.rmSync(outDir, { recursive: true, force: true });
await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile: path.join(outDir, "worker/index.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  external: ["cloudflare:*"],
  define: { __VIMS_SANDBOX_VERSION__: JSON.stringify(version) },
  legalComments: "none",
  logLevel: "warning",
});

const manifest = {
  schema: 2,
  version,
  script: {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: [],
    modules: [{ name: "index.js", type: "application/javascript+module" }],
    observability: { enabled: true },
  },
  durable_object: { binding: "SANDBOX", class_name: "VimsSandbox", storage: "sqlite" },
  container: { class_name: "VimsSandbox" },
  token_secret: "SANDBOX_TOKEN",
  images: Object.fromEntries(Object.entries(lock).map(([name, rt]) => [name, { source: rt.source, size_bytes: rt.sizeBytes }])),
};
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const size = fs.statSync(path.join(outDir, "worker/index.js")).size;
console.log(`${version}: worker ${size} bytes, runtimes ${Object.keys(lock).join(", ")}`);
