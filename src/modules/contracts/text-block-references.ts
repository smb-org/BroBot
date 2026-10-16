/** Returns namespaced text-block placeholders from a template string. */
export const blockReferencesInText = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{text\.([a-z0-9_]{1,32})\}/gu)].flatMap((match) => match[1] === undefined ? [] : [match[1]]))];

export interface TextBlockPreviewSource {
  name: string;
  revision: number;
  games?: readonly unknown[];
  variants: readonly { conditions: unknown; texts: readonly string[] }[];
}

export type TextBlockPreviewDependency =
  | { name: string; missing: true }
  | { name: string; missing: false; revision: number; games: readonly unknown[]; variants: readonly { conditions: unknown; texts: readonly string[] }[] };

/** Collects only the referenced block graph, including missing names and each block revision. */
export const textBlockPreviewDependencies = (
  text: string,
  blocks: readonly TextBlockPreviewSource[],
): TextBlockPreviewDependency[] => {
  const blocksByName = new Map(blocks.map((block) => [block.name, block]));
  const dependencies = new Map<string, TextBlockPreviewDependency>();
  const pendingNames = blockReferencesInText(text);

  while (pendingNames.length > 0) {
    const name = pendingNames.shift();
    if (name === undefined || dependencies.has(name)) continue;

    const block = blocksByName.get(name);
    if (block === undefined) {
      dependencies.set(name, { name, missing: true });
      continue;
    }

    dependencies.set(name, {
      name,
      missing: false,
      revision: block.revision,
      games: block.games ?? [],
      variants: block.variants,
    });
    for (const variant of block.variants) pendingNames.push(...blockReferencesInText(variant.texts.join(" ")));
  }

  return [...dependencies.values()].sort((left, right) => left.name.localeCompare(right.name));
};

/** Rewrites one exact text-block token without changing similarly named references. */
export const rewriteTextBlockReference = (text: string, fromName: string, toName: string): string =>
  text.replaceAll(`{text.${fromName}}`, `{text.${toName}}`);
