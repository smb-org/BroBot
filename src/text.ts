const EVENT_TEXT_MAXIMUM_LENGTH = 200;

/** Formats a whole-number count with the channel's display language. */
export const formatCount = (value: number, language: "de" | "en"): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(value);

/** Truncates logged text visibly to at most 200 characters. */
export const truncateTo200Chars = (text: string): string =>
  text.length <= EVENT_TEXT_MAXIMUM_LENGTH
    ? text
    : `${text.slice(0, EVENT_TEXT_MAXIMUM_LENGTH - 1)}…`;

/**
 * A SHA-256 content fingerprint, used to tell full values apart when just
 * their `truncateTo200Chars` preview is kept (audit log review, #181): two
 * different values past the cutoff can truncate to the identical preview.
 */
export const textFingerprint = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** The fingerprint to store alongside a truncated preview -- `undefined` when the preview already carries the whole value, so callers can omit the field entirely. */
export const textFingerprintIfTruncated = async (text: string): Promise<string | undefined> =>
  text.length > EVENT_TEXT_MAXIMUM_LENGTH ? textFingerprint(text) : undefined;
