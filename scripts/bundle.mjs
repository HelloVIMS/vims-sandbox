#!/usr/bin/env node
// Builds the bundle VIMS deploys through the Cloudflare API (no wrangler on
// the user's machine): the Worker as one ES module, plus a manifest naming
// its bindings, container class and the runtime images (from
// runtimes.lock.json) to copy into the account's registry. Files a runtime
// image is assembled from are downloaded, checked against the lock and
// written to <out-dir>-assets/ for the versioned release; the manifest
// points at them there, so a deploy always gets the bytes the lock pinned.
//
//   node scripts/bundle.mjs <out-dir> [version]
//   → <out-dir>/manifest.json, <out-dir>/worker/index.js, <out-dir>-assets/*
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const version = process.argv[3] ?? `vims-sandbox-${execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim()}`;
const lock = JSON.parse(fs.readFileSync(path.join(root, "runtimes.lock.json"), "utf8"));

const RELEASES = process.env.VIMS_SANDBOX_RELEASES ?? "https://github.com/HelloVIMS/vims-sandbox/releases/download";
const assetsDir = `${outDir}-assets`;
const DIGEST = /@sha256:[0-9a-f]{64}$/;
for (const [name, rt] of Object.entries(lock)) {
  if (!DIGEST.test(rt.source)) throw new Error(`runtimes.lock.json: ${name} is not digest-pinned`);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(assetsDir, { recursive: true, force: true });

// An assembled image's files as the manifest names them: URL files mirrored
// into this release (checked against the lock first).
async function manifestFiles(runtime, files) {
  const out = [];
  for (const f of files) {
    const base = { path: f.path, mode: f.mode };
    if (f.content_base64 !== undefined) out.push({ ...base, content_base64: f.content_base64 });
    else if (f.vims) out.push({ ...base, vims: f.vims });
    else {
      const r = await fetch(f.source, { redirect: "follow" });
      if (!r.ok) throw new Error(`${f.source}: ${r.status}`);
      const data = Buffer.from(await r.arrayBuffer());
      const sum = createHash("sha256").update(data).digest("hex");
      if (sum !== f.sha256) throw new Error(`${f.source} changed since it was locked (sha256 ${sum}, lock says ${f.sha256}) — re-run scripts/lock-images.mjs`);
      const asset = `${runtime}-${path.basename(f.path)}`;
      fs.mkdirSync(assetsDir, { recursive: true });
      fs.writeFileSync(path.join(assetsDir, asset), data);
      out.push({ ...base, url: `${RELEASES}/${version}/${asset}`, sha256: f.sha256, size: f.size });
    }
  }
  return out;
}
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
  images: {},
};
for (const [name, rt] of Object.entries(lock)) {
  manifest.images[name] = { source: rt.source, size_bytes: rt.sizeBytes, ...(rt.files ? { files: await manifestFiles(name, rt.files) } : {}) };
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const size = fs.statSync(path.join(outDir, "worker/index.js")).size;
console.log(`${version}: worker ${size} bytes, runtimes ${Object.keys(lock).join(", ")}`);
