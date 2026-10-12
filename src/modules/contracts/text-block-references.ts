/** Returns namespaced text-block placeholders from a template string. */
export const blockReferencesInText = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{text\.([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))];
