const EVENT_TEXT_MAXIMUM_LENGTH = 200;

/** Truncates logged text visibly to at most 200 characters. */
export const truncateTo200Chars = (text: string): string =>
  text.length <= EVENT_TEXT_MAXIMUM_LENGTH
    ? text
    : `${text.slice(0, EVENT_TEXT_MAXIMUM_LENGTH - 1)}…`;

/**
 * A cheap, non-cryptographic content fingerprint (djb2) -- not for security,
 * only for telling two full values apart when just their `truncateTo200Chars`
 * preview is kept (audit log review, #181): two different values past the
 * cutoff can truncate to the identical preview, so the preview alone can't
 * tell an edit past character 200 from no edit at all.
 */
export const textFingerprint = (text: string): string => {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 33) + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
};

/** The fingerprint to store alongside a truncated preview -- `undefined` when the preview already carries the whole value, so callers can omit the field entirely. */
export const textFingerprintIfTruncated = (text: string): string | undefined =>
  text.length > EVENT_TEXT_MAXIMUM_LENGTH ? textFingerprint(text) : undefined;
