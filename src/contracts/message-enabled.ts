/** Resolves a saved message switch while preserving settings written before the switch existed. */
export const isMessageEnabled = (
  settings: object,
  messageKey: string,
  enabledKey: string,
  messageIndex?: number,
): boolean => {
  const values = settings as Record<string, unknown>;
  const explicitValue = values[enabledKey];
  const message = values[messageKey];
  if (messageIndex !== undefined) {
    if (Array.isArray(explicitValue) && typeof explicitValue[messageIndex] === "boolean") return explicitValue[messageIndex];
    return Array.isArray(message) && typeof message[messageIndex] === "string" && message[messageIndex].trim().length > 0;
  }
  if (typeof explicitValue === "boolean") return explicitValue;
  return typeof message === "string" && message.trim().length > 0;
};
