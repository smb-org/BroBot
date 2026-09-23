import { describe, expect, it } from "vitest";

import { textFingerprint, textFingerprintIfTruncated, truncateTo200Chars } from "../../src/text";

describe("truncateTo200Chars", () => {
  it("leaves text at or under 200 characters untouched", () => {
    expect(truncateTo200Chars("short")).toBe("short");
    expect(truncateTo200Chars("A".repeat(200))).toBe("A".repeat(200));
  });

  it("truncates longer text to 199 characters plus an ellipsis", () => {
    const truncated = truncateTo200Chars("A".repeat(205));
    expect(truncated).toBe(`${"A".repeat(199)}…`);
    expect(truncated.length).toBe(200);
  });
});

describe("textFingerprint", () => {
  it("is deterministic for the same input", () => {
    expect(textFingerprint("hello world")).toBe(textFingerprint("hello world"));
  });

  it("differs for different input -- the case a truncated preview alone can't tell apart", () => {
    // Two values that are identical for the first 200 characters (so they'd
    // truncate to the same preview) but differ after that.
    const a = `${"A".repeat(200)}tail-one`;
    const b = `${"A".repeat(200)}tail-two`;
    expect(truncateTo200Chars(a)).toBe(truncateTo200Chars(b));
    expect(textFingerprint(a)).not.toBe(textFingerprint(b));
  });
});

describe("textFingerprintIfTruncated", () => {
  it("is undefined when the preview already carries the whole value", () => {
    expect(textFingerprintIfTruncated("short")).toBeUndefined();
    expect(textFingerprintIfTruncated("A".repeat(200))).toBeUndefined();
  });

  it("is the fingerprint once the value is long enough to be truncated", () => {
    const text = "A".repeat(205);
    expect(textFingerprintIfTruncated(text)).toBe(textFingerprint(text));
  });
});
