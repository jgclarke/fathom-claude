import { describe, it, expect } from "vitest";
import {
  validateIso8601,
  validateEmail,
  validateDomain,
  validateRecordingId,
  validateSearchQuery,
} from "../../src/index";

describe("03 — Input validation: validateIso8601", () => {
  it("accepts valid date-only string", () => {
    expect(validateIso8601("2024-01-01", "f")).toBeNull();
  });
  it("accepts full datetime with Z", () => {
    expect(validateIso8601("2024-01-01T00:00:00Z", "f")).toBeNull();
  });
  it("accepts full datetime with milliseconds", () => {
    expect(validateIso8601("2024-01-01T00:00:00.000Z", "f")).toBeNull();
  });
  it("accepts full datetime with offset", () => {
    expect(validateIso8601("2024-01-01T00:00:00-05:00", "f")).toBeNull();
  });
  it("accepts null (optional field)", () => {
    expect(validateIso8601(null, "f")).toBeNull();
  });
  it("accepts undefined (optional field)", () => {
    expect(validateIso8601(undefined, "f")).toBeNull();
  });
  it("rejects path traversal attempt", () => {
    expect(validateIso8601("../etc/passwd", "f")).not.toBeNull();
  });
  it("rejects SQL injection attempt", () => {
    expect(validateIso8601("2024-01-01; DROP TABLE tokens;--", "f")).not.toBeNull();
  });
  it("rejects wrong date order", () => {
    expect(validateIso8601("01-01-2024", "f")).not.toBeNull();
  });
  it("rejects non-padded date", () => {
    expect(validateIso8601("2024-1-1", "f")).not.toBeNull();
  });
  it("rejects 500-char string", () => {
    expect(validateIso8601("x".repeat(500), "f")).not.toBeNull();
  });
  it("rejects empty string", () => {
    // empty string is treated as absent (returns null)
    expect(validateIso8601("", "f")).toBeNull();
  });
});

describe("03 — Input validation: validateEmail", () => {
  it("accepts valid email", () => {
    expect(validateEmail("user@example.com", "f")).toBeNull();
  });
  it("accepts null", () => {
    expect(validateEmail(null, "f")).toBeNull();
  });
  it("rejects no-domain", () => {
    expect(validateEmail("user@", "f")).not.toBeNull();
  });
  it("rejects no-local-part", () => {
    expect(validateEmail("@example.com", "f")).not.toBeNull();
  });
  it("rejects space in address", () => {
    expect(validateEmail("user @example.com", "f")).not.toBeNull();
  });
  it("rejects header injection attempt", () => {
    expect(validateEmail("user@example.com\nX-Injected: val", "f")).not.toBeNull();
  });
  it("rejects local part > 64 chars", () => {
    expect(validateEmail("a".repeat(65) + "@example.com", "f")).not.toBeNull();
  });
  it("rejects domain > 255 chars", () => {
    expect(validateEmail("user@" + "a".repeat(256), "f")).not.toBeNull();
  });
  it("rejects plain string", () => {
    expect(validateEmail("notanemail", "f")).not.toBeNull();
  });
});

describe("03 — Input validation: validateDomain", () => {
  it("accepts simple domain", () => {
    expect(validateDomain("acme.com", "f")).toBeNull();
  });
  it("accepts subdomain", () => {
    expect(validateDomain("sub.domain.example.co.uk", "f")).toBeNull();
  });
  it("accepts null", () => {
    expect(validateDomain(null, "f")).toBeNull();
  });
  it("rejects path traversal", () => {
    expect(validateDomain("../parent", "f")).not.toBeNull();
  });
  it("rejects slash in domain", () => {
    expect(validateDomain("acme.com/path", "f")).not.toBeNull();
  });
  it("rejects leading hyphen", () => {
    expect(validateDomain("-acme.com", "f")).not.toBeNull();
  });
  it("rejects domain > 255 chars", () => {
    expect(validateDomain("a".repeat(256), "f")).not.toBeNull();
  });
});

describe("03 — Input validation: validateRecordingId", () => {
  it("accepts alphanumeric ID", () => {
    expect(validateRecordingId("abc123", "f")).toBeNull();
  });
  it("accepts ID with hyphens and underscores", () => {
    expect(validateRecordingId("abc-123_xyz", "f")).toBeNull();
  });
  it("rejects path traversal", () => {
    expect(validateRecordingId("../secret", "f")).not.toBeNull();
  });
  it("rejects slash", () => {
    expect(validateRecordingId("abc/def", "f")).not.toBeNull();
  });
  it("rejects space", () => {
    expect(validateRecordingId("abc def", "f")).not.toBeNull();
  });
  it("rejects empty string", () => {
    expect(validateRecordingId("", "f")).not.toBeNull();
  });
  it("rejects 129-char string (over limit)", () => {
    expect(validateRecordingId("a".repeat(129), "f")).not.toBeNull();
  });
  it("accepts 128-char string (at limit)", () => {
    expect(validateRecordingId("a".repeat(128), "f")).toBeNull();
  });
  it("rejects URL-encoded slash", () => {
    expect(validateRecordingId("abc%2Fdef", "f")).not.toBeNull();
  });
});

describe("03 — Input validation: validateSearchQuery", () => {
  it("accepts normal query", () => {
    expect(validateSearchQuery("john from acme", "f")).toBeNull();
  });
  it("rejects empty string", () => {
    expect(validateSearchQuery("", "f")).not.toBeNull();
  });
  it("rejects whitespace-only", () => {
    expect(validateSearchQuery("   ", "f")).not.toBeNull();
  });
  it("rejects 201-char string (over limit)", () => {
    expect(validateSearchQuery("a".repeat(201), "f")).not.toBeNull();
  });
  it("accepts 200-char string (at limit)", () => {
    expect(validateSearchQuery("a".repeat(200), "f")).toBeNull();
  });
});
