import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
type Runtime = {
  files?: Array<{ path: string; from?: string; source?: string; sha256?: string; size?: number }>;
};
const sources = JSON.parse(readFileSync(new URL("../runtimes.json", import.meta.url), "utf8")) as Record<string, Runtime>;
const locked = JSON.parse(readFileSync(new URL("../runtimes.lock.json", import.meta.url), "utf8")) as Record<string, Runtime>;
const prefix = "https://github.com/HelloVIMS/Runtimes/releases/download/";
describe("version-specific runtime downloads", () => {
  for (const runtime of ["hermes", "openfang", "nemoclaw"]) {
    it(`${runtime} declares the same version-specific asset that its lock verifies`, () => {
      const declared = sources[runtime]!.files!.find((file) => file.from?.startsWith(prefix));
      const pinned = locked[runtime]!.files!.find((file) => file.path === declared?.path);
      expect(declared).toBeDefined();
      expect(pinned).toBeDefined();
      expect(pinned!.source).toBe(declared!.from);
      const path = new URL(pinned!.source!).pathname;
      expect(path).toMatch(new RegExp(`^/HelloVIMS/Runtimes/releases/download/${runtime}-[0-9a-f]{12,64}/${runtime}-linux-amd64$`));
      expect(pinned!.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(Number.isSafeInteger(pinned!.size)).toBe(true);
      expect(pinned!.size).toBeGreaterThan(0);
    });
  }
  it("never introduces a rolling latest URL in either runtime file", () => {
    for (const collection of [sources, locked]) {
      for (const runtime of Object.values(collection)) {
        for (const file of runtime.files ?? []) {
          for (const url of [file.from, file.source]) {
            if (url?.startsWith(prefix)) expect(url).not.toContain("/download/latest/");
          }
        }
      }
    }
  });
});
