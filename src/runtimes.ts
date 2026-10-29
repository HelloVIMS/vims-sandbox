// The runtimes this build can start, from runtimes.lock.json (pinned by
// scripts/lock-images.mjs). Deploys copy each `source` into the account's
// registry; the container application names each image after its runtime.
import lock from "../runtimes.lock.json";

export interface RuntimeImage {
  from: string;
  source: string;
  entrypoint: string[];
  cmd: string[];
  user: string;
  sizeBytes: number;
  /** A POSIX shell in the image, or null (distroless: no wrapper, env-only config). */
  shell: string | null;
}

export const RUNTIMES: Readonly<Record<string, RuntimeImage>> = lock;
export const RUNTIME_NAMES: readonly string[] = Object.keys(RUNTIMES).sort();
