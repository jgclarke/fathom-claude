import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  seedAuthCode, FAKE_CODE, KNOWN_VERIFIER, KNOWN_CHALLENGE, FAKE_FATHOM_KEY,
} from "../helpers";

function tokenRequest(code: string, verifier: string): Request {
  return new Request("https://worker.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=authorization_code&code=${code}&code_verifier=${verifier}`,
  });
}

describe("06 — PKCE enforcement", () => {
  beforeEach(async () => {
    await seedAuthCode(FAKE_CODE, KNOWN_CHALLENGE, FAKE_FATHOM_KEY);
  });

  it("valid verifier → 200 + access_token", async () => {
    const res = await SELF.fetch(tokenRequest(FAKE_CODE, KNOWN_VERIFIER));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.access_token).toBeTruthy();
    expect(body.token_type).toBe("bearer");
  });

  it("wrong verifier → 400 invalid_grant", async () => {
    await seedAuthCode(FAKE_CODE, KNOWN_CHALLENGE, FAKE_FATHOM_KEY);
    const res = await SELF.fetch(tokenRequest(FAKE_CODE, "wrongverifier"));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_grant");
  });

  it("empty code_verifier → 400 invalid_request", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code=${FAKE_CODE}&code_verifier=`,
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_request");
  });

  it("missing code → 400 invalid_request", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=authorization_code&code_verifier=${KNOWN_VERIFIER}`,
    }));
    expect(res.status).toBe(400);
  });

  it("auth code is deleted after successful exchange (single-use)", async () => {
    await SELF.fetch(tokenRequest(FAKE_CODE, KNOWN_VERIFIER));
    // Second attempt with same code → should fail
    const res2 = await SELF.fetch(tokenRequest(FAKE_CODE, KNOWN_VERIFIER));
    expect(res2.status).toBe(400);
    const body = await res2.json() as any;
    expect(body.error).toBe("invalid_grant");
  });

  it("a 'consumed' sentinel is written before PKCE, preventing concurrent replay", async () => {
    // The sentinel closes the TOCTOU race: two concurrent requests with the same
    // valid code cannot both succeed because the first one to write "consumed"
    // wins; the second sees "consumed" and gets invalid_grant.
    // As a tradeoff, a failed PKCE also burns the code (the sentinel is written
    // before verification). Legitimate clients always send the correct verifier,
    // so this only matters under active attack.
    const res1 = await SELF.fetch(tokenRequest(FAKE_CODE, "wrongverifier"));
    expect(res1.status).toBe(400);
    const body1 = await res1.json() as any;
    expect(body1.error).toBe("invalid_grant");
    // Code is now consumed — even the correct verifier is rejected
    const res2 = await SELF.fetch(tokenRequest(FAKE_CODE, KNOWN_VERIFIER));
    expect(res2.status).toBe(400);
    const body2 = await res2.json() as any;
    expect(body2.error).toBe("invalid_grant");
  });

  it("unknown code → 400 invalid_grant", async () => {
    const res = await SELF.fetch(tokenRequest("unknowncode999", KNOWN_VERIFIER));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("invalid_grant");
  });

  it("wrong grant_type → 400 unsupported_grant_type", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&code=${FAKE_CODE}&code_verifier=${KNOWN_VERIFIER}`,
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe("unsupported_grant_type");
  });
});
