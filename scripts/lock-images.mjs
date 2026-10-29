#!/usr/bin/env node
// Pins each runtime in runtimes.json to its current linux/amd64 image digest
// and records the image's entrypoint and command (the Worker wraps them), in
// runtimes.lock.json. Review the diff and commit it: deploys only ever run
// the digests in the lock.
//
//   node scripts/lock-images.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(fs.readFileSync(path.join(root, "runtimes.json"), "utf8"));

const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

function parseRef(ref) {
  const m = /^([^/]+)\/(.+?)(?::([^:@/]+))?(?:@(sha256:[0-9a-f]{64}))?$/.exec(ref);
  if (!m) throw new Error(`bad image reference ${ref}`);
  const [, host, repo, tag, digest] = m;
  return { host: host === "docker.io" ? "registry-1.docker.io" : host, repo, ref: digest ?? tag ?? "latest", display: host };
}

async function token(host, repo) {
  const probe = await fetch(`https://${host}/v2/`);
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  if (!realm) return null;
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  const u = new URL(realm);
  if (service) u.searchParams.set("service", service);
  u.searchParams.set("scope", `repository:${repo}:pull`);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${host}: token ${r.status}`);
  const j = await r.json();
  return j.token ?? j.access_token;
}

async function get(host, repo, kind, ref, tok, accept) {
  const r = await fetch(`https://${host}/v2/${repo}/${kind}/${ref}`, { headers: { accept, ...(tok ? { authorization: `Bearer ${tok}` } : {}) } });
  if (!r.ok) throw new Error(`${host}/${repo} ${kind}/${ref}: ${r.status}`);
  return { body: await r.json(), digest: r.headers.get("docker-content-digest") };
}

async function resolve(ref) {
  const { host, repo, ref: tagOrDigest, display } = parseRef(ref);
  const tok = await token(host, repo);
  let { body, digest } = await get(host, repo, "manifests", tagOrDigest, tok, ACCEPT);
  if (body.manifests) {
    const m = body.manifests.find((x) => x.platform?.os === "linux" && x.platform?.architecture === "amd64");
    if (!m) throw new Error(`${ref} has no linux/amd64 image`);
    ({ body } = await get(host, repo, "manifests", m.digest, tok, ACCEPT));
    digest = m.digest;
  }
  if (!digest) throw new Error(`${ref}: registry gave no digest`);
  const cfg = await fetch(`https://${host}/v2/${repo}/blobs/${body.config.digest}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} }).then((r) => r.json());
  const size = body.layers.reduce((n, l) => n + l.size, 0);
  return {
    source: `${display}/${repo}@${digest}`,
    entrypoint: cfg.config?.Entrypoint ?? [],
    cmd: cfg.config?.Cmd ?? [],
    user: cfg.config?.User ?? "",
    sizeBytes: size,
  };
}

const lock = {};
for (const [name, src] of Object.entries(sources)) {
  const r = await resolve(src.image);
  lock[name] = { from: src.image, ...r, shell: src.shell };
  console.log(`${name}: ${r.source} (${Math.round(r.sizeBytes / 2 ** 20)} MB)`);
}
fs.writeFileSync(path.join(root, "runtimes.lock.json"), JSON.stringify(lock, null, 2) + "\n");
