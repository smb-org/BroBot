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
  it("is deterministic for the same input", async () => {
    expect(await textFingerprint("hello world")).toBe(await textFingerprint("hello world"));
  });

  it("differs for different input -- the case a truncated preview alone can't tell apart", async () => {
    // Two values that are identical for the first 200 characters (so they'd
    // truncate to the same preview) but differ after that.
    const a = `${"A".repeat(200)}tail-one`;
    const b = `${"A".repeat(200)}tail-two`;
    expect(truncateTo200Chars(a)).toBe(truncateTo200Chars(b));
    expect(await textFingerprint(a)).not.toBe(await textFingerprint(b));
  });

  it("avoids the known djb2 collision beyond the preview cutoff", async () => {
    const a = `${"A".repeat(200)}aA`;
    const b = `${"A".repeat(200)}b `;
    expect(truncateTo200Chars(a)).toBe(truncateTo200Chars(b));
    expect(await textFingerprint(a)).not.toBe(await textFingerprint(b));
  });
});

describe("textFingerprintIfTruncated", () => {
  it("is undefined when the preview already carries the whole value", async () => {
    await expect(textFingerprintIfTruncated("short")).resolves.toBeUndefined();
    await expect(textFingerprintIfTruncated("A".repeat(200))).resolves.toBeUndefined();
  });

  it("is the fingerprint once the value is long enough to be truncated", async () => {
    const text = "A".repeat(205);
    await expect(textFingerprintIfTruncated(text)).resolves.toBe(await textFingerprint(text));
  });
});
