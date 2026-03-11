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
});
