/** Returns namespaced text-block placeholders from a template string. */
export const blockReferencesInText = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{text\.([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))];

/** Rewrites one exact text-block token without changing similarly named references. */
export const rewriteTextBlockReference = (text: string, fromName: string, toName: string): string =>
  text.replaceAll(`{text.${fromName}}`, `{text.${toName}}`);
