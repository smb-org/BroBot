const EVENT_TEXT_MAXIMUM_LENGTH = 200;

/** Truncates logged text visibly to at most 200 characters. */
export const truncateTo200Chars = (text: string): string =>
  text.length <= EVENT_TEXT_MAXIMUM_LENGTH
    ? text
    : `${text.slice(0, EVENT_TEXT_MAXIMUM_LENGTH - 1)}…`;
