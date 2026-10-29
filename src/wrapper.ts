// The entrypoint wrapper for runtime images that have a POSIX shell. It runs
// before the runtime's own entrypoint and:
//   1. creates the directories VIMS asked for (VIMS_MKDIRS, ':'-separated)
//      and writes the config files it seeded (VIMS_FILE_<n>_PATH / _B64),
//   2. waits for the egress-interception CA the Worker's intercepts make
//      Cloudflare place in the container (HTTPS to allowed hosts needs it),
//   3. execs the runtime with stdout+stderr copied to RUNTIME_LOG, which the
//      Worker's logs endpoint tails.
// Images without a shell (distroless) start their entrypoint directly and
// take their configuration from env alone.

export const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
export const RUNTIME_LOG = "/tmp/vims-runtime.log";
const FIFO = "/tmp/vims-runtime.fifo";

export const MAX_FILES = 32;
export const MAX_FILE_BYTES = 256 * 1024;

export const WRAPPER_SCRIPT = [
  "set -e",
  'if [ -n "${VIMS_MKDIRS:-}" ]; then (IFS=:; for d in $VIMS_MKDIRS; do mkdir -p "$d"; done); fi',
  "unset VIMS_MKDIRS",
  "i=0",
  'while :; do eval "p=\\${VIMS_FILE_${i}_PATH:-}"; [ -n "$p" ] || break',
  '  eval "b=\\${VIMS_FILE_${i}_B64:-}"',
  '  mkdir -p "$(dirname "$p")"',
  '  printf %s "$b" | base64 -d > "$p.vims-tmp" && mv "$p.vims-tmp" "$p"',
  '  unset "VIMS_FILE_${i}_PATH" "VIMS_FILE_${i}_B64"',
  "  i=$((i+1))",
  "done",
  "n=0",
  `while [ ! -s ${CA_PATH} ] && [ $n -lt 150 ]; do sleep 0.1; n=$((n+1)); done`,
  `[ -s ${CA_PATH} ] || echo "vims-sandbox: egress CA not present after 15s; HTTPS to allowed hosts will fail" >&2`,
  `rm -f ${FIFO}; mkfifo ${FIFO}`,
  `tee -a ${RUNTIME_LOG} < ${FIFO} &`,
  `exec "$@" > ${FIFO} 2>&1`,
].join("\n");

export interface SeedFile {
  path: string;
  contentBase64: string;
}

const safePath = (p: string) => p.startsWith("/") && !p.split("/").includes("..") && !/[\0\n:]/.test(p);

/** Env carrying the seed directories and files to the wrapper. Throws on unsafe input. */
export function fileEnv(files: SeedFile[], dirs: string[] = []): Record<string, string> {
  if (files.length > MAX_FILES || dirs.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} seed files and ${MAX_FILES} directories`);
  const env: Record<string, string> = {};
  for (const d of dirs) {
    if (!safePath(d)) throw new Error(`seed directory must be absolute without "..": ${JSON.stringify(d)}`);
  }
  if (dirs.length) env.VIMS_MKDIRS = dirs.join(":");
  let total = 0;
  files.forEach((f, i) => {
    if (!safePath(f.path)) {
      throw new Error(`seed file path must be absolute without "..": ${JSON.stringify(f.path)}`);
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.contentBase64)) throw new Error(`seed file ${f.path} is not base64`);
    total += f.contentBase64.length;
    if (total > MAX_FILE_BYTES) throw new Error(`seed files exceed ${MAX_FILE_BYTES} bytes`);
    env[`VIMS_FILE_${i}_PATH`] = f.path;
    env[`VIMS_FILE_${i}_B64`] = f.contentBase64;
  });
  return env;
}

/** The container entrypoint for a runtime command. */
export function entrypointFor(shell: string | null, command: string[]): string[] {
  return shell ? [shell, "-c", WRAPPER_SCRIPT, "vims-sandbox", ...command] : command;
}
