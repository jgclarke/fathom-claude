import { describe, it, expect } from "vitest";
import { timingSafeEqual } from "../../src/index";

describe("07 — Timing-safe comparison", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
  });

  it("returns false when strings differ at the last character", () => {
    expect(timingSafeEqual("abcX", "abcY")).toBe(false);
  });

  it("returns false when strings differ at the first character", () => {
    expect(timingSafeEqual("Xbc", "Ybc")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("returns false when b is a prefix of a", () => {
    expect(timingSafeEqual("abcdef", "abc")).toBe(false);
  });

  it("returns false when a is a prefix of b", () => {
    expect(timingSafeEqual("abc", "abcdef")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("returns false for empty vs non-empty", () => {
    expect(timingSafeEqual("", "a")).toBe(false);
    expect(timingSafeEqual("a", "")).toBe(false);
  });

  it("still iterates full length when strings differ at position 0 (no early return)", () => {
    // If there were an early return, a mismatch at position 0 of a very long
    // string would return much faster than a match. We can't prove timing
    // precisely but we can verify correctness of the full-scan behavior.
    const a = "A" + "x".repeat(999);
    const b = "B" + "x".repeat(999);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it("length-mismatch branch XORs real bytes (not ^ 0 no-op)", () => {
    // Previously the length-mismatch branch did `diff |= charCodeAt(i) ^ 0`
    // which is a no-op (any value XOR 0 = itself, never changes diff meaningfully
    // because we still return false). The real bug is that it leaked timing:
    // the loop only ran over `a.length` with no comparison to `b`.
    // The fix pads both byte arrays to max(a.length, b.length) and XORs them.
    // Verify: different-length strings with identical prefix are still false.
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    // And crucially: the length difference itself is included in the XOR accumulator,
    // so length(3) ^ length(4) = 7 != 0 → always false even if bytes all match.
    expect(timingSafeEqual("abc", "abc\x00")).toBe(false); // \x00 padded byte
  });
});
