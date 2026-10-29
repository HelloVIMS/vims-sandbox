import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The router and Durable Object import base classes from the Workers
    // runtime; unit tests give them inert stand-ins.
    alias: { "cloudflare:workers": path.resolve(import.meta.dirname, "test/cloudflare-workers-stub.ts") },
  },
});
