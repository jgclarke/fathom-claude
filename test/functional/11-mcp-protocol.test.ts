import { describe, it, expect, beforeEach } from "vitest";
import { SELF } from "cloudflare:test";
import { seedToken, mcpPost, FAKE_TOKEN, INITIALIZE_MSG, TOOLS_LIST_MSG } from "../helpers";

// Tests MCP JSON-RPC protocol behavior — method routing, response shape, error codes.
// These do not depend on Fathom API calls succeeding.

describe("11 — MCP protocol", () => {
  beforeEach(async () => {
    await seedToken();
  });

  it("initialize returns correct protocolVersion and serverInfo", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2024-11-05");
    expect(body.result.serverInfo.name).toBe("fathom-mcp");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list returns all expected tools", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, TOOLS_LIST_MSG));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain("list_meetings");
    expect(names).toContain("get_transcript");
    expect(names).toContain("get_summary");
    expect(names).toContain("search_meetings");
    // Each tool must have a name, description, and inputSchema
    for (const tool of body.result.tools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeDefined();
    }
  });

  it("unknown MCP method returns -32601 method not found", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, {
      jsonrpc: "2.0", id: 99, method: "does/not/exist", params: {},
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32601);
  });

  it("tools/call with unknown tool name returns -32601", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32601);
  });

  it("invalid JSON body returns -32700 parse error", async () => {
    const res = await SELF.fetch(new Request("https://worker.test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FAKE_TOKEN}` },
      body: "this is not json {{{",
    }));
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe(-32700);
  });

  it("response Content-Type is application/json", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, INITIALIZE_MSG));
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  it("notifications/initialized is accepted without error", async () => {
    const res = await SELF.fetch(mcpPost(FAKE_TOKEN, {
      jsonrpc: "2.0", id: 3, method: "notifications/initialized", params: {},
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});
