// Egress policy, evaluated exactly as VIMS's pkg/policy NetworkPolicy.Evaluate:
// the first rule whose host, method and path match decides; no match falls
// back to the default. VIMS expands presets into rules before sending them,
// so the Worker and the local egress proxy enforce the same list.

export interface EgressRule {
  name?: string;
  host: string;
  methods?: string[];
  paths?: string[];
  /** "allow" (default) or "deny". */
  action?: string;
}

export interface EgressPolicy {
  default: "allow" | "deny";
  rules: EgressRule[];
}

export interface Verdict {
  allowed: boolean;
  rule?: string;
  reason: string;
}

/** Exact host, "*", or "*.example.com" (which also matches example.com). */
export function matchHost(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === "*") return true;
  if (p.startsWith("*.")) return h === p.slice(2) || h.endsWith(p.slice(1));
  return p === h;
}

/** Empty list = every method. */
export function matchMethods(allowed: string[] | undefined, method: string): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.some((m) => m.toUpperCase() === method.toUpperCase());
}

/** Empty list = every path; "/v1/*" matches "/v1" and anything under it. */
export function matchPaths(patterns: string[] | undefined, path: string): boolean {
  if (!patterns || patterns.length === 0) return true;
  for (const p of patterns) {
    if (p === "/*" || p === "*") return true;
    if (p.endsWith("/*")) {
      const prefix = p.slice(0, -1);
      if (path.startsWith(prefix) || path === p.slice(0, -2)) return true;
    }
    if (p === path) return true;
  }
  return false;
}

export function evaluate(policy: EgressPolicy, host: string, method: string, path: string): Verdict {
  const h = host.toLowerCase().split(":")[0] ?? "";
  const m = method.toUpperCase();
  for (const rule of policy.rules) {
    if (!matchHost(rule.host, h) || !matchMethods(rule.methods, m) || !matchPaths(rule.paths, path)) continue;
    const action = (rule.action || "allow").toLowerCase();
    return { allowed: action === "allow", rule: rule.name, reason: `matched rule "${rule.name ?? rule.host}"` };
  }
  return { allowed: policy.default === "allow", reason: `no matching rule; default=${policy.default}` };
}

/** A policy from untrusted JSON, or null. Unknown defaults deny. */
export function parsePolicy(raw: unknown): EgressPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { default?: unknown; rules?: unknown };
  if (!Array.isArray(r.rules ?? [])) return null;
  const rules: EgressRule[] = [];
  for (const x of (r.rules as unknown[]) ?? []) {
    if (!x || typeof x !== "object") return null;
    const rule = x as Record<string, unknown>;
    if (typeof rule.host !== "string" || !rule.host) return null;
    const strings = (v: unknown) => (Array.isArray(v) && v.every((s) => typeof s === "string") ? (v as string[]) : undefined);
    rules.push({
      host: rule.host,
      ...(typeof rule.name === "string" ? { name: rule.name } : {}),
      ...(strings(rule.methods) ? { methods: strings(rule.methods) } : {}),
      ...(strings(rule.paths) ? { paths: strings(rule.paths) } : {}),
      ...(typeof rule.action === "string" ? { action: rule.action } : {}),
    });
  }
  return { default: r.default === "allow" ? "allow" : "deny", rules };
}
