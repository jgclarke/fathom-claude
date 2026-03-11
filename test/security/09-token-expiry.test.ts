import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN, INITIALIZE_MSG, seedAuthCode, FAKE_CODE, KNOWN_VERIFIER, KNOWN_CHALLENGE, FAKE_FATHOM_KEY } from "../helpers";

describe("09 — Token and code expiry", () => {
  it("KV returns null for unknown token → MCP returns 401", async () => {
    // Do NOT seed the token — KV lookup returns null
    const res = await SELF.fetch(mcpPost("nonexistenttoken", INITIALIZE_MSG));
    expect(res.status).toBe(401);
  });

  it("expired token (deleted from KV) → subsequent MCP request returns 401", async () => {
    await seedToken(FAKE_TOKEN);
    // Simulate expiry by deleting directly
    await env.FATHOM_KV.delete(`token:${FAKE_TOKEN}`);
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.status).toBe(401);
  });

  it("handleRevoke with unknown token → 200 (RFC 7009 compliance)", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=doesnotexist",
    }));
    expect(res.status).toBe(200);
  });

  it("handleRevoke with valid token → subsequent MCP request returns 401", async () => {
    await seedToken(FAKE_TOKEN);
    await SELF.fetch(new Request("https://worker.test/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${FAKE_TOKEN}`,
    }));
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.status).toBe(401);
  });

  it("auth code stored under correct KV key prefix 'auth_code:'", async () => {
    await seedAuthCode(FAKE_CODE, KNOWN_CHALLENGE, FAKE_FATHOM_KEY);
    const stored = await env.FATHOM_KV.get(`auth_code:${FAKE_CODE}`);
    expect(stored).not.toBeNull();
    // Verify the wrong prefix returns nothing
    const wrong = await env.FATHOM_KV.get(`code:${FAKE_CODE}`);
    expect(wrong).toBeNull();
  });

  it("token stored under correct KV key prefix 'token:'", async () => {
    await seedToken(FAKE_TOKEN);
    const stored = await env.FATHOM_KV.get(`token:${FAKE_TOKEN}`);
    expect(stored).not.toBeNull();
    const wrong = await env.FATHOM_KV.get(`access_token:${FAKE_TOKEN}`);
    expect(wrong).toBeNull();
  });

  it("token exchange stores new token under 'token:' prefix in KV", async () => {
    await seedAuthCode(FAKE_CODE, KNOWN_CHALLENGE, FAKE_FATHOM_KEY);
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${FAKE_CODE}&code_verifier=${KNOWN_VERIFIER}`,
    }));
    const body = await res.json() as any;
    const token = body.access_token;
    expect(token).toBeTruthy();
    const stored = await env.FATHOM_KV.get(`token:${token}`);
    expect(stored).not.toBeNull();
  });
});
