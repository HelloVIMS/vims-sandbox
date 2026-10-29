// What VIMS sends to start an instance, validated before any of it reaches a
// container.
import { isProvider, type ModelRoute } from "./gateway";
import { parsePolicy, type EgressPolicy } from "./policy";
import { MAX_FILES, type SeedFile } from "./wrapper";

export const INSTANCE_TYPES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

export interface StartSpec {
  instanceId: string;
  runtime: string;
  /** The port the runtime listens on inside the container. */
  port: number;
  env: Record<string, string>;
  files: SeedFile[];
  /** Replaces the image's CMD (the image entrypoint stays). */
  args?: string[];
  egress: EgressPolicy;
  model: ModelRoute;
  /** The token the runtime presents to the model gateway. */
  gatewayToken: string;
  instance: InstanceType;
  inactivityTimeoutMs: number;
}

export const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIN_TIMEOUT = 60_000;
const MAX_TIMEOUT = 6 * 60 * 60_000;
export const DEFAULT_TIMEOUT = 2 * 60 * 60_000;

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** A StartSpec from untrusted JSON, or an error naming the first problem. */
export function parseSpec(instanceId: string, raw: unknown, runtimes: readonly string[]): StartSpec | string {
  if (!INSTANCE_ID.test(instanceId)) return "instance id must be 1-64 letters, digits, '-' or '_'";
  if (!raw || typeof raw !== "object") return "body must be a JSON object";
  const r = raw as Record<string, unknown>;
  if (typeof r.runtime !== "string" || !runtimes.includes(r.runtime)) return `runtime must be one of: ${runtimes.join(", ")}`;
  if (typeof r.port !== "number" || !Number.isInteger(r.port) || r.port < 1 || r.port > 65535) return "port must be 1-65535";
  const env = (r.env ?? {}) as Record<string, unknown>;
  if (typeof env !== "object" || Array.isArray(env)) return "env must be an object";
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || k.startsWith("VIMS_FILE_")) return `bad env name ${k}`;
    if (typeof v !== "string" || v.includes("\0")) return `env ${k} must be a string`;
  }
  const files = r.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) return `files must be a list of at most ${MAX_FILES}`;
  for (const f of files) {
    if (!f || typeof f !== "object" || typeof (f as SeedFile).path !== "string" || typeof (f as SeedFile).contentBase64 !== "string") {
      return "each file needs path and contentBase64";
    }
  }
  if (r.args !== undefined && !strings(r.args)) return "args must be a list of strings";
  const egress = parsePolicy(r.egress ?? { default: "deny", rules: [] });
  if (!egress) return "egress must be { default, rules: [{ host, methods?, paths?, action? }] }";
  const model = r.model as Record<string, unknown> | undefined;
  if (!model || !isProvider(model.provider) || typeof model.model !== "string" || !model.model) {
    return "model must be { provider, model } with a provider the sandbox gateway serves";
  }
  if (typeof r.gatewayToken !== "string" || r.gatewayToken.length < 16) return "gatewayToken must be at least 16 characters";
  const instance = (r.instance ?? "standard-1") as InstanceType;
  if (!INSTANCE_TYPES.includes(instance)) return `instance must be one of: ${INSTANCE_TYPES.join(", ")}`;
  const timeout = r.inactivityTimeoutMs ?? DEFAULT_TIMEOUT;
  if (typeof timeout !== "number" || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) return "inactivityTimeoutMs must be between 1 minute and 6 hours";
  return {
    instanceId,
    runtime: r.runtime,
    port: r.port,
    env: env as Record<string, string>,
    files: files as SeedFile[],
    ...(r.args !== undefined ? { args: r.args as string[] } : {}),
    egress,
    model: { provider: model.provider, model: model.model },
    gatewayToken: r.gatewayToken,
    instance,
    inactivityTimeoutMs: timeout,
  };
}

/** A stable fingerprint of a spec: a running container is reused only for the same one. */
export async function specHash(spec: StartSpec): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(spec));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
