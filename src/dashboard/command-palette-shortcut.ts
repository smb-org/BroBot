export const isCommandPaletteShortcut = (
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey">,
  isMacPlatform: boolean,
): boolean => event.key.toLowerCase() === "k" && (isMacPlatform
  ? event.metaKey && !event.ctrlKey
  : event.ctrlKey && !event.metaKey);
