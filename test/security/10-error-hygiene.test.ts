import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN, INITIALIZE_MSG } from "../helpers";

describe("10 — Error response hygiene", () => {
  it("401 response body contains no stack trace", async () => {
    const res = await SELF.fetch(mcpPost(null, INITIALIZE_MSG));
    const text = await res.text();
    expect(text).not.toMatch(/\s+at\s+\w/);
  });

  it("401 response body does not mention KV internals", async () => {
    const res = await SELF.fetch(mcpPost(null, INITIALIZE_MSG));
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("kv_namespace");
    expect(text.toLowerCase()).not.toContain("fathom_kv");
  });

  it("Fathom API auth failure → generic user-facing message, not raw status code", async () => {
    await seedToken();
    // The FAKE_FATHOM_KEY won't auth with real Fathom — we get a Fathom 401
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, {
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "list_meetings", arguments: { created_after: "2024-01-01" } },
      })
    );
    const body = await res.json() as any;
    const text: string = body.result?.content?.[0]?.text ?? "";
    // Should get a friendly message, not a raw "HTTP 401" or stack trace
    expect(text).not.toMatch(/HTTP \d{3}/);
    expect(text).not.toMatch(/\s+at\s+\w/);
    expect(text).not.toContain("FATHOM_BASE");
  }, 30_000);

  it("handleToken with totally invalid body → 400, not 500", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{{not valid urlencoded",
    }));
    // Should be 400, not 500
    expect(res.status).toBeLessThan(500);
  });

  it("unknown MCP method returns error with code -32601, not a stack trace", async () => {
    await seedToken();
    const res = await SELF.fetch(
      mcpPost(FAKE_TOKEN, { jsonrpc: "2.0", id: 1, method: "nonexistent/method", params: {} })
    );
    const body = await res.json() as any;
    expect(body.error?.code).toBe(-32601);
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toMatch(/\s+at\s+\w/);
  });

  it("open redirect: authorize GET with non-Claude redirect_uri → HTML error, not redirect", async () => {
    const res = await SELF.fetch(new Request(
      "https://worker.test/oauth/authorize?" + new URLSearchParams({
        redirect_uri: "https://evil.com/callback",
        response_type: "code",
        code_challenge: "abc",
        code_challenge_method: "S256",
        state: "xyz",
      })
    ));
    // Must NOT be a 302 redirect to evil.com
    expect(res.status).not.toBe(302);
    expect(res.headers.get("Location") ?? "").not.toContain("evil.com");
  });

  it("oauth/register with non-Claude redirect_uri → 400, not 201", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://evil.com/callback"],
        client_name: "Evil Client",
      }),
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  it("oauth/register with invalid JSON body → 400 not 500", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid json",
    }));
    expect(res.status).toBe(400);
  });
});
