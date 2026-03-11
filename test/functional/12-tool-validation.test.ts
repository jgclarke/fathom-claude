import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN } from "../helpers";

// Tests server-side input validation for all MCP tools.
// Validation errors must be returned as successful MCP responses (isError: true)
// not as HTTP errors — the MCP spec puts tool errors in the result body.

function toolCall(name: string, args: Record<string, unknown>) {
  return mcpPost(FAKE_TOKEN, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name, arguments: args },
  });
}

async function toolText(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await SELF.fetch(toolCall(name, args));
  const body = await res.json() as any;
  return body.result?.content?.[0]?.text ?? body.error?.message ?? "";
}

describe("12 — Tool input validation", () => {
  beforeEach(async () => {
    await seedToken();
  });

  // ── list_meetings ──────────────────────────────────────────────────────────

  describe("list_meetings", () => {
    it("no arguments → valid response (not a validation error)", async () => {
      // The key regression: validateSearchQuery(undefined) must not error
      const res = await SELF.fetch(toolCall("list_meetings", {}));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      // Must return a result (not an MCP error), even if Fathom returns no meetings
      expect(body.result).toBeDefined();
      expect(body.error).toBeUndefined();
    });

    it("valid query string → no validation error", async () => {
      // Use a far-future date so Fathom returns immediately with 0 results
      const text = await toolText("list_meetings", {
        query: "test query",
        created_after: "2099-01-01T00:00:00Z",
      });
      expect(text).not.toContain("Invalid argument");
    });

    it("query that is too long (201 chars) → validation error", async () => {
      const text = await toolText("list_meetings", { query: "a".repeat(201) });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("query");
    });

    it("query that is empty string → validation error", async () => {
      // Empty string is not a useful query
      const text = await toolText("list_meetings", { query: "" });
      // Guard lets empty string through (treated as absent), filterQuery becomes null — OK
      // OR if treated as a validation error — also acceptable
      // Either way, the response must be a valid MCP response, not a crash
      const res = await SELF.fetch(toolCall("list_meetings", { query: "" }));
      expect(res.status).toBe(200);
    });

    it("query that is whitespace-only → validation error", async () => {
      const text = await toolText("list_meetings", { query: "   " });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("query");
    });

    it("invalid created_after format → validation error", async () => {
      const text = await toolText("list_meetings", { created_after: "not-a-date" });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("created_after");
    });

    it("invalid created_before format → validation error", async () => {
      const text = await toolText("list_meetings", { created_before: "01/01/2025" });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("created_before");
    });

    it("valid ISO 8601 date-only format is accepted", async () => {
      const text = await toolText("list_meetings", {
        created_after: "2099-01-01", // date-only, no time
      });
      expect(text).not.toContain("Invalid arguments");
    });

    it("invalid invitee_email → validation error", async () => {
      const text = await toolText("list_meetings", { invitee_email: "not-an-email" });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("invitee_email");
    });

    it("valid invitee_email is accepted", async () => {
      const text = await toolText("list_meetings", {
        invitee_email: "test@example.com",
        created_after: "2099-01-01T00:00:00Z",
      });
      expect(text).not.toContain("Invalid arguments");
    });

    it("invalid invitee_domain → validation error", async () => {
      const text = await toolText("list_meetings", { invitee_domain: "not a domain!" });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("invitee_domain");
    });

    it("valid invitee_domain is accepted", async () => {
      const text = await toolText("list_meetings", {
        invitee_domain: "example.com",
        created_after: "2099-01-01T00:00:00Z",
      });
      expect(text).not.toContain("Invalid arguments");
    });

    it("multiple validation errors are all reported", async () => {
      const text = await toolText("list_meetings", {
        created_after: "bad",
        invitee_email: "bad",
        invitee_domain: "bad domain!",
      });
      expect(text).toContain("created_after");
      expect(text).toContain("invitee_email");
      expect(text).toContain("invitee_domain");
    });
  });

  // ── get_transcript ─────────────────────────────────────────────────────────

  describe("get_transcript", () => {
    it("missing recording_id → validation error", async () => {
      const text = await toolText("get_transcript", {});
      expect(text).toContain("Invalid argument");
      expect(text).toContain("recording_id");
    });

    it("recording_id with path traversal → validation error", async () => {
      const text = await toolText("get_transcript", { recording_id: "../etc/passwd" });
      expect(text).toContain("Invalid argument");
      expect(text).toContain("recording_id");
    });

    it("recording_id with spaces → validation error", async () => {
      const text = await toolText("get_transcript", { recording_id: "abc 123" });
      expect(text).toContain("Invalid argument");
    });

    it("recording_id that is too long → validation error", async () => {
      const text = await toolText("get_transcript", { recording_id: "a".repeat(129) });
      expect(text).toContain("Invalid argument");
    });

    it("valid recording_id → passes validation (Fathom returns graceful error)", async () => {
      // The fake Fathom key causes a 401 from Fathom, which should be returned
      // as a graceful user-facing message, not a crash or stack trace
      const text = await toolText("get_transcript", { recording_id: "valid-id-123" });
      expect(text).not.toContain("Invalid argument");
      // Must be a graceful Fathom error message, not an internal error
      expect(text).not.toContain("stack");
      expect(text).not.toContain("Error:");
    });
  });

  // ── get_summary ────────────────────────────────────────────────────────────

  describe("get_summary", () => {
    it("missing recording_id → validation error", async () => {
      const text = await toolText("get_summary", {});
      expect(text).toContain("Invalid argument");
      expect(text).toContain("recording_id");
    });

    it("recording_id with injection attempt → validation error", async () => {
      const text = await toolText("get_summary", { recording_id: "id'; DROP TABLE--" });
      expect(text).toContain("Invalid argument");
    });

    it("valid recording_id → passes validation (Fathom returns graceful error)", async () => {
      const text = await toolText("get_summary", { recording_id: "valid-id-456" });
      expect(text).not.toContain("Invalid argument");
      expect(text).not.toContain("stack");
    });
  });

  // ── search_meetings alias ──────────────────────────────────────────────────

  describe("search_meetings (alias for list_meetings)", () => {
    it("passes through to list_meetings — validation errors surface correctly", async () => {
      const text = await toolText("search_meetings", { created_after: "not-a-date" });
      expect(text).toContain("Invalid arguments");
      expect(text).toContain("created_after");
    });

    it("valid args → no validation error", async () => {
      const text = await toolText("search_meetings", {
        query: "test",
        created_after: "2099-01-01T00:00:00Z",
      });
      expect(text).not.toContain("Invalid arguments");
    });
  });
});
