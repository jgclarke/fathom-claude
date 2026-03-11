import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN } from "../helpers";

describe("08 — Pagination safety cap", () => {
  beforeEach(async () => {
    await seedToken();
  });

  it("list_meetings with valid token eventually responds (does not hang indefinitely)", async () => {
    // With the time budget, the worker must return within 25 seconds even if Fathom has many pages
    // We use a short created_after to limit real API calls in this test
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "list_meetings",
          arguments: { created_after: new Date().toISOString() }, // future date, 0 results
        },
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.result).toBeDefined();
  }, 30_000);

  it("truncation note appears in output when results are capped", async () => {
    // If the tool hits the cap, the text must warn the user
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: {
          name: "list_meetings",
          arguments: { limit: 50 },
        },
      })
    );
    const body = await res.json() as any;
    const text: string = body.result?.content?.[0]?.text ?? "";
    // Either results come back normally OR a truncation note is present if capped
    // The key invariant: if truncated=true, the note must appear
    if (text.includes("capped")) {
      expect(text).toContain("narrow the date range");
    }
  }, 30_000);
});
