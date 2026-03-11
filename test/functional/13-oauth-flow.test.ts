import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

// Tests the OAuth 2.0 endpoints for correct behavior and structure.
// These do not depend on a real Fathom key succeeding.

describe("13 — OAuth flow", () => {

  // ── Discovery metadata ─────────────────────────────────────────────────────

  describe("/.well-known/oauth-authorization-server", () => {
    it("returns 200 with required OAuth metadata fields", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/.well-known/oauth-authorization-server"));
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(typeof body.issuer).toBe("string");
      expect(typeof body.authorization_endpoint).toBe("string");
      expect(typeof body.token_endpoint).toBe("string");
      expect(Array.isArray(body.response_types_supported)).toBe(true);
      expect(Array.isArray(body.grant_types_supported)).toBe(true);
      expect(body.code_challenge_methods_supported).toContain("S256");
    });

    it("endpoints in metadata point to the same host", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/.well-known/oauth-authorization-server"));
      const body = await res.json() as any;
      expect(body.authorization_endpoint).toContain("worker.test");
      expect(body.token_endpoint).toContain("worker.test");
    });
  });

  // ── Dynamic client registration ────────────────────────────────────────────

  describe("POST /oauth/register", () => {
    it("returns 201 with client_id for a well-formed request", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://claude.ai/oauth/callback"],
        }),
      }));
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(typeof body.client_id).toBe("string");
      expect(body.redirect_uris).toEqual(["https://claude.ai/oauth/callback"]);
    });

    it("rejects non-Claude redirect_uri", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Evil Client",
          redirect_uris: ["https://evil.example.com/callback"],
        }),
      }));
      expect(res.status).toBe(400);
    });
  });

  // ── Authorize form ─────────────────────────────────────────────────────────

  describe("GET /oauth/authorize", () => {
    it("renders the auth form for valid Claude redirect_uri", async () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: "claude-test",
        redirect_uri: "https://claude.ai/oauth/callback",
        state: "test-state-123",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      });
      const res = await SELF.fetch(new Request(`https://worker.test/oauth/authorize?${params}`));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<form");
      expect(html).toContain("Fathom");
    });

    it("non-Claude redirect_uri → renders HTML error page (not a redirect)", async () => {
      // The authorize GET returns a user-facing HTML page for errors, not an HTTP 4xx.
      // Critically, it must NOT redirect to the attacker's URI.
      const params = new URLSearchParams({
        response_type: "code",
        client_id: "evil",
        redirect_uri: "https://evil.example.com/steal",
        state: "x",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
      });
      const res = await SELF.fetch(new Request(`https://worker.test/oauth/authorize?${params}`));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Invalid Request");
      // Must NOT contain the attacker URI as a redirect target
      expect(html).not.toContain("evil.example.com");
    });

    it("missing required params → renders HTML error page (not a redirect)", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/authorize"));
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Invalid Request");
    });
  });

  // ── Token endpoint ─────────────────────────────────────────────────────────

  describe("POST /oauth/token", () => {
    it("missing code → 400 invalid_request", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code_verifier=abc",
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("invalid_request");
    });

    it("wrong grant_type → 400 unsupported_grant_type", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=implicit&code=abc&code_verifier=abc",
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("unsupported_grant_type");
    });

    it("unknown code → 400 invalid_grant", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=doesnotexist&code_verifier=anything",
      }));
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toBe("invalid_grant");
    });
  });

  // ── Revoke endpoint ────────────────────────────────────────────────────────

  describe("POST /oauth/revoke", () => {
    it("always returns 200 even for unknown token (RFC 7009)", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=doesnotexist",
      }));
      expect(res.status).toBe(200);
    });

    it("missing token body → still 200 (revoke is always idempotent)", async () => {
      const res = await SELF.fetch(new Request("https://worker.test/oauth/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }));
      expect(res.status).toBe(200);
    });
  });
});
