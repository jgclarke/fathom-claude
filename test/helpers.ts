import { env } from "cloudflare:test";

export const KNOWN_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const KNOWN_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

export const FAKE_FATHOM_KEY = "test-fathom-api-key-abc123";
export const FAKE_TOKEN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FAKE_CODE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export async function seedToken(token = FAKE_TOKEN, fathomApiKey = FAKE_FATHOM_KEY) {
  await env.FATHOM_KV.put(
    `token:${token}`,
    JSON.stringify({ fathomApiKey, issuedAt: Date.now() })
  );
}

export async function seedAuthCode(
  code = FAKE_CODE,
  codeChallenge = KNOWN_CHALLENGE,
  fathomApiKey = FAKE_FATHOM_KEY
) {
  await env.FATHOM_KV.put(
    `auth_code:${code}`,
    JSON.stringify({ fathomApiKey, codeChallenge })
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
