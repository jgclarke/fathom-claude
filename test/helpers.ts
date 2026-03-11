import { env } from "cloudflare:test";
import { encryptValue } from "../src/index";

export const KNOWN_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const KNOWN_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

export const FAKE_FATHOM_KEY = "test-fathom-api-key-abc123";
export const FAKE_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_CODE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// Must match the KV_ENCRYPTION_KEY binding in vitest.config.ts miniflare.bindings.
// This is a test-only key — never used in production.
export const TEST_ENCRYPTION_KEY = "0101010101010101010101010101010101010101010101010101010101010101";

export async function seedToken(token = FAKE_TOKEN, fathomApiKey = FAKE_FATHOM_KEY) {
  const encryptedKey = await encryptValue(fathomApiKey, TEST_ENCRYPTION_KEY);
  await env.FATHOM_KV.put(
    `token:${token}`,
    JSON.stringify({ fathomApiKey: encryptedKey, issuedAt: Date.now() })
  );
}

export async function seedAuthCode(
  code = FAKE_CODE,
  codeChallenge = KNOWN_CHALLENGE,
  fathomApiKey = FAKE_FATHOM_KEY
) {
  const encryptedKey = await encryptValue(fathomApiKey, TEST_ENCRYPTION_KEY);
  await env.FATHOM_KV.put(
    `auth_code:${code}`,
    JSON.stringify({ fathomApiKey: encryptedKey, codeChallenge })
  );
}

export function mcpPost(token: string | null, body: object): Request {
  return new Request("https://worker.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

export const INITIALIZE_MSG = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
};

export const TOOLS_LIST_MSG = {
  jsonrpc: "2.0", id: 2, method: "tools/list", params: {},
};
