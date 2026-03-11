import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { FAKE_FATHOM_KEY, INITIALIZE_MSG, seedToken, FAKE_TOKEN, mcpPost } from "../helpers";

// DEV_MODE bypass was removed (finding 2). These tests verify that:
// 1. X-Fathom-Key header is never accepted as authentication on the /mcp endpoint
// 2. Only valid Bearer tokens from the OAuth flow are accepted
// 3. The removal didn't break the normal OAuth token path

describe("02 — DEV_MODE bypass removed", () => {
  it("X-Fathom-Key header alone (no Bearer) → 401 (bypass is gone)", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fathom-Key": FAKE_FATHOM_KEY },
      body: JSON.stringify(INITIALIZE_MSG),
    }));
    expect(res.status).toBe(401);
  });

  it("X-Fathom-Key + Bearer in same request — only Bearer is checked → 401 for bad token", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fathom-Key": FAKE_FATHOM_KEY,
        "Authorization": "Bearer invalidtoken",
      },
      body: JSON.stringify(INITIALIZE_MSG),
    }));
    expect(res.status).toBe(401);
  });

  it("no credentials at all → 401", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INITIALIZE_MSG),
    }));
    expect(res.status).toBe(401);
  });

  it("valid Bearer token (from OAuth flow) → 200", async () => {
    await seedToken();
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.status).toBe(200);
  });

  it("valid Bearer token takes precedence over any X-Fathom-Key header", async () => {
    await seedToken();
    const res = await SELF.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${FAKE_TOKEN}`,
        "X-Fathom-Key": "should-be-ignored",
      },
      body: JSON.stringify(INITIALIZE_MSG),
    }));
    expect(res.status).toBe(200);
  });
});
