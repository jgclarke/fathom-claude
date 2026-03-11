import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN, INITIALIZE_MSG } from "../helpers";

describe("01 — Auth bypass prevention", () => {
  it("POST /mcp with no Authorization header → 401", async () => {
    const res = await SELF.fetch(mcpPost(null, INITIALIZE_MSG));
    expect(res.status).toBe(401);
  });

  it("POST /mcp with empty Bearer → 401", async () => {
    const req = new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " },
      body: JSON.stringify(INITIALIZE_MSG),
    });
    const res = await SELF.fetch(req);
    expect(res.status).toBe(401);
  });

  it("POST /mcp with garbage token → 401", async () => {
    const res = await SELF.fetch(mcpPost("notavalidtoken", INITIALIZE_MSG));
    expect(res.status).toBe(401);
  });

  it("POST /mcp with valid seeded token → 200", async () => {
    await seedToken();
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.status).toBe(200);
  });

  it("GET /mcp with no Authorization → 401", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", { method: "GET" }));
    expect(res.status).toBe(401);
  });

  it("OPTIONS /mcp → 200 (preflight, no auth required)", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", { method: "OPTIONS" }));
    expect(res.status).toBe(200);
  });

  it("401 body contains no stack trace", async () => {
    const res = await SELF.fetch(mcpPost(null, INITIALIZE_MSG));
    const text = await res.text();
    expect(text).not.toMatch(/at \w/);
    expect(text).not.toContain("Error:");
  });

  it("401 body does not echo the token sent in the request", async () => {
    const sentToken = "supersecrettoken12345";
    const res = await SELF.fetch(mcpPost(sentToken, INITIALIZE_MSG));
    const text = await res.text();
    expect(text).not.toContain(sentToken);
  });

  it("401 body does not mention KV internals", async () => {
    const res = await SELF.fetch(mcpPost(null, INITIALIZE_MSG));
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("kv");
    expect(text.toLowerCase()).not.toContain("namespace");
  });
});
