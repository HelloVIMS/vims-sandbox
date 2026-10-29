import { describe, expect, it } from "vitest";
import vectors from "./egress_vectors.json";
import { evaluate, parsePolicy, type EgressPolicy } from "../src/policy";

describe("egress policy (parity with VIMS pkg/policy)", () => {
  for (const c of vectors.cases) {
    it(`${c.policy}: ${c.method} ${c.host}${c.path} → ${c.allowed ? "allow" : "deny"}`, () => {
      const policy = parsePolicy(vectors.policies[c.policy as keyof typeof vectors.policies]) as EgressPolicy;
      const v = evaluate(policy, c.host, c.method, c.path);
      expect(v.allowed).toBe(c.allowed);
      if ("rule" in c) expect(v.rule).toBe(c.rule);
    });
  }

  it("rejects malformed policies and denies by default", () => {
    expect(parsePolicy({ rules: [{ host: "" }] })).toBeNull();
    expect(parsePolicy({ rules: [{ host: "a.com", methods: [1] }] })?.rules[0]?.methods).toBeUndefined();
    expect(parsePolicy({ rules: "x" })).toBeNull();
    expect(parsePolicy({ default: "maybe", rules: [] })?.default).toBe("deny");
  });
});
