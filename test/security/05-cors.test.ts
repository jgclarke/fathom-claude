import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN, INITIALIZE_MSG } from "../helpers";

describe("05 — CORS: MCP endpoint", () => {
  it("POST /mcp ACAO is exactly 'null' (not wildcard)", async () => {
    await seedToken();
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).toBe("null");
    expect(acao).not.toBe("*");
  });

  it("OPTIONS /mcp ACAO is exactly 'null'", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", { method: "OPTIONS" }));
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).toBe("null");
    expect(acao).not.toBe("*");
  });

  it("MCP response does not have wildcard CORS", async () => {
    await seedToken();
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });
});

describe("05 — CORS: OAuth endpoints", () => {
  it("/.well-known/oauth-authorization-server ACAO is https://claude.ai", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/.well-known/oauth-authorization-server"));
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).toBe("https://claude.ai");
  });

  it("OAuth metadata ACAO is not wildcard", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/.well-known/oauth-authorization-server"));
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
  });

  it("POST /oauth/token ACAO is https://claude.ai", async () => {
    // Send an invalid request — we just want the CORS header, not a successful exchange
    const res = await SELF.fetch(new Request("https://worker.test/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=authorization_code&code=bad&code_verifier=bad",
    }));
    const acao = res.headers.get("Access-Control-Allow-Origin");
    expect(acao).toBe("https://claude.ai");
    expect(acao).not.toBe("*");
  });

  it("POST /oauth/revoke ACAO is https://claude.ai", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "token=something",
    }));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://claude.ai");
  });
});
