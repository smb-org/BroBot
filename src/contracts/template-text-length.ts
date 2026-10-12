/** Length used for persisted template fields; namespaced block references cost their legacy bare-name length. */
export const templateTextLength = (text: string): number =>
  text.length - "text.".length * [...text.matchAll(/\{text\.[a-z0-9_]{1,32}\}/gu)].length;
