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
});
