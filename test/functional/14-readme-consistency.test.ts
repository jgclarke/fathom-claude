import { describe, it, expect } from "vitest";
import { ACCESS_TOKEN_TTL_SECONDS, AUTH_CODE_TTL_SECONDS, TOOLS } from "../../src/index";
import readmeContent from "../../README.md?raw";
import wranglerToml from "../../wrangler.toml?raw";

/**
 * README consistency tests.
 *
 * These tests derive expected documentation content directly from source
 * constants and structure. If a TTL changes, a tool is added or renamed,
 * or a key placeholder changes, these tests fail — forcing the README
 * to be updated before the build passes.
 *
 * When a test here fails:
 *   1. Update the README to reflect the code change
 *   2. Verify the test passes again
 */

describe("14 — README consistency", () => {

  // ── Token lifetimes ────────────────────────────────────────────────────────

  it("README access token TTL matches ACCESS_TOKEN_TTL_SECONDS constant", () => {
    const days = ACCESS_TOKEN_TTL_SECONDS / 86400;
    expect(days).toBe(Math.floor(days)); // must be a whole number of days
    expect(readmeContent).toContain(`${days} days`);
  });

  it("README auth code TTL matches AUTH_CODE_TTL_SECONDS constant", () => {
    const minutes = AUTH_CODE_TTL_SECONDS / 60;
    expect(minutes).toBe(Math.floor(minutes)); // must be a whole number of minutes
    expect(readmeContent).toContain(`${minutes} minutes`);
  });

  // ── Tool names ─────────────────────────────────────────────────────────────

  it("README documents every tool defined in TOOLS", () => {
    for (const tool of TOOLS) {
      expect(readmeContent).toContain(tool.name);
    }
  });

  it("README tool count matches TOOLS array length", () => {
    // Count tool names in the README table (lines containing backtick-wrapped tool names)
    const documented = TOOLS.filter(tool =>
      readmeContent.includes(`\`${tool.name}\``)
    );
    expect(documented.length).toBe(TOOLS.length);
  });

  // ── wrangler.toml placeholders ─────────────────────────────────────────────

  it("wrangler.toml does not contain a real-looking KV namespace ID (32-char hex)", () => {
    // Real Cloudflare KV namespace IDs are 32-character lowercase hex strings.
    // The committed wrangler.toml must use placeholder text, not a real ID.
    const realIdPattern = /\bid\s*=\s*"[0-9a-f]{32}"/;
    expect(realIdPattern.test(wranglerToml)).toBe(false);
  });

  it("README explains how to set up wrangler.local.toml for deployment", () => {
    expect(readmeContent).toContain("wrangler.local.toml");
  });

  it("README references the correct deploy command", () => {
    expect(readmeContent).toContain("--config wrangler.local.toml");
  });

  // ── Security claims ────────────────────────────────────────────────────────

  it("README security section does not describe stale DEV_MODE bypass behavior", () => {
    // DEV_MODE bypass was removed. README must not claim it exists.
    expect(readmeContent.toLowerCase()).not.toContain("dev_mode");
    expect(readmeContent.toLowerCase()).not.toContain("x-fathom-key");
  });

  // ── Sensitive content must not appear in README ────────────────────────────

  it("README does not contain a real-looking KV namespace ID (32-char hex)", () => {
    // A committed KV namespace ID leaks infrastructure details.
    const realIdPattern = /[0-9a-f]{32}/;
    expect(realIdPattern.test(readmeContent)).toBe(false);
  });

  it("README does not contain a real-looking Cloudflare account ID (32-char hex)", () => {
    // Same pattern as KV namespace IDs — catches accidental exposure.
    const accountIdPattern = /[0-9a-f]{32}/;
    expect(accountIdPattern.test(readmeContent)).toBe(false);
  });

  it("README does not contain anything that looks like a Fathom API key", () => {
    // Fathom API keys start with "fathom_" followed by alphanumeric chars.
    const fathomKeyPattern = /fathom_[a-zA-Z0-9]{8,}/;
    expect(fathomKeyPattern.test(readmeContent)).toBe(false);
  });

  it("README does not contain anything that looks like a Bearer token (64-char hex)", () => {
    // Access tokens are 64-char hex strings. Should never appear in docs.
    const tokenPattern = /[0-9a-f]{64}/;
    expect(tokenPattern.test(readmeContent)).toBe(false);
  });

  it("README does not expose the live Worker URL", () => {
    // The worker subdomain is kept private. The README intentionally
    // uses a placeholder — verify no real workers.dev URL slipped in.
    expect(readmeContent).not.toMatch(/https:\/\/[a-z0-9-]+\.workers\.dev/);
  });

  it("README does not contain private internal endpoint paths beyond what is public", () => {
    // KV key prefixes like "token:" and "auth_code:" are internal implementation
    // details. They appear in the security section intentionally (token rotation
    // instructions), so this test only guards against accidental raw KV dumps.
    // Ensure no raw JSON KV payloads leaked into the README.
    expect(readmeContent).not.toContain('"fathomApiKey"');
    expect(readmeContent).not.toContain('"issuedAt"');
    expect(readmeContent).not.toContain('"codeChallenge"');
  });
});
