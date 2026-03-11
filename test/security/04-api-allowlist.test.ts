import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN } from "../helpers";

// We test the allowlist indirectly: list_meetings calls fathomGet("/meetings", ...)
// We can verify disallowed paths cause the right error by calling tools that would
// trigger them if validation were bypassed. For direct path tests we test via
// the MCP tool call and verify the disallowed path error is NOT exposed to the user.

describe("04 — API path allowlist", () => {
  it("get_transcript with valid ID returns a Fathom-sourced error, not a path error", async () => {
    await seedToken();
    // The recording endpoint /recordings/abc123/transcript IS in the allowlist
    // A real Fathom call will fail with 401 (no real key) but not a path error
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_transcript", arguments: { recording_id: "abc123" } },
      })
    );
    const body = await res.json() as any;
    const text: string = body.result?.content?.[0]?.text ?? "";
    // Should get a Fathom error, not a "Disallowed API path" error
    expect(text).not.toContain("Disallowed");
  });

  it("recording_id with path traversal chars is rejected by validation before fathomGet", async () => {
    await seedToken();
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_transcript", arguments: { recording_id: "../admin" } },
      })
    );
    const body = await res.json() as any;
    const text: string = body.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Invalid argument");
    expect(text).not.toContain("Disallowed API path");
    // The user-facing error must not echo the malicious path
    expect(text).not.toContain("../admin");
  });

  it("user-facing MCP error does not expose internal Disallowed path message", async () => {
    await seedToken();
    // get_transcript with a valid-looking ID — this hits Fathom which returns 401
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "get_transcript", arguments: { recording_id: "validid123" } },
      })
    );
    const body = await res.json() as any;
    const text: string = body.result?.content?.[0]?.text ?? "";
    expect(text).not.toContain("Disallowed API path");
    expect(text).not.toContain("FATHOM_BASE");
    expect(text).not.toContain("api.fathom.ai");
  });
});
