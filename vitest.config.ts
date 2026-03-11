import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          kvNamespaces: ["FATHOM_KV"],
          // Test-only encryption key (32 bytes of 0x01). Never use in production.
          // Must match TEST_ENCRYPTION_KEY in test/helpers.ts.
          bindings: { KV_ENCRYPTION_KEY: "0101010101010101010101010101010101010101010101010101010101010101" },
        },
      },
    },
  },
});
