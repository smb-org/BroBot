export const CHAT_MESSAGE_MAXIMUM_LENGTH = 500;
export const CHAT_MENTION_PREFIX = /^@[a-zA-Z0-9_]{1,25} /u;

export const chatAttributionSuffix = (attributions: readonly string[]): string => [...new Set(attributions.map((value) => {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  return safe.trim();
}).filter(Boolean))].map((label) => ` · ${label}`).join("");

/** Truncates the reply body while reserving a complete suffix and transport attributions. */
export const reserveChatTextBeforeSuffix = (
  text: string,
  suffix: string,
  attributions: readonly string[] = [],
): string | null => {
  const prefix = CHAT_MENTION_PREFIX.exec(text)?.[0] ?? "";
  const body = text.slice(prefix.length);
  const reservedLength = prefix.length + suffix.length + chatAttributionSuffix(attributions).length;
  const availableBodyLength = CHAT_MESSAGE_MAXIMUM_LENGTH - reservedLength;
  if (availableBodyLength < 0) return null;
  const preparedBody = body.length <= availableBodyLength
    ? body
    : availableBodyLength === 0
      ? ""
      : `${body.slice(0, availableBodyLength - 1)}…`;
  return `${prefix}${preparedBody}${suffix}`;
};
