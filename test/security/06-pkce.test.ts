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

  it("auth code survives a failed PKCE attempt (not a DoS vector)", async () => {
    // Auth code must NOT be deleted on a failed PKCE check.
    // If it were deleted before verification, an attacker could burn a legitimate
    // code by sending a bad verifier before the real client completes the exchange.
    // First attempt: wrong verifier → should fail
    const res1 = await SELF.fetch(tokenRequest(FAKE_CODE, "wrongverifier"));
    expect(res1.status).toBe(400);
    const body1 = await res1.json() as any;
    expect(body1.error).toBe("invalid_grant");
    // Second attempt: correct verifier — code still exists → should succeed
    const res2 = await SELF.fetch(tokenRequest(FAKE_CODE, KNOWN_VERIFIER));
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as any;
    expect(body2.access_token).toBeTruthy();
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
