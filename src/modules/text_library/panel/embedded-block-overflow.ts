import { TEXT_BLOCK_MAXIMUMS, type TextBlockVariant } from "../contracts";
import { SYSTEM_TEMPLATE_VARIABLE_LIST } from "../../contract";

interface TemplateLengthVariable {
  name: string;
  maxLength: number;
}

export interface EmbeddedBlockOverflow {
  length: number;
  blockNames: readonly string[];
}

const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?)\}/gu;

export const estimateEmbeddedBlockOverflow = (
  texts: readonly string[],
  blocks: ReadonlyMap<string, readonly TextBlockVariant[]>,
  variables: readonly TemplateLengthVariable[],
): EmbeddedBlockOverflow | null => {
  const variableLength = (name: string, tokenLength: number): number =>
    variables.find((variable) => variable.name === name)?.maxLength ??
    SYSTEM_TEMPLATE_VARIABLE_LIST.find((variable) => variable.name === name)?.maxLength ?? tokenLength;

  const estimateText = (text: string, path: readonly string[], resolveBlocks: boolean): { length: number; embeddedBlocks: string[] } => {
    let length = text.length;
    const embeddedBlocks: string[] = [];
    for (const match of text.matchAll(TOKEN_PATTERN)) {
      const name = match[1];
      if (name === undefined) continue;
      const variants = blocks.get(name);
      const replacementLength = variants === undefined
        ? variableLength(name, match[0].length)
        : resolveBlocks
          ? estimateBlock(name, path).length
          : match[0].length;
      length += replacementLength - match[0].length;
      if (variants !== undefined) embeddedBlocks.push(name);
    }
    return { length, embeddedBlocks };
  };

  const estimateBlock = (name: string, path: readonly string[]): { length: number } => {
    if (path.includes(name)) return { length: TEXT_BLOCK_MAXIMUMS.renderedLength };
    const variants = blocks.get(name) ?? [];
    const nextPath = [...path, name];
    const maximum = variants.reduce((max, variant) => Math.max(
      max,
      ...variant.texts.map((text) => estimateText(text, nextPath, true).length),
    ), 0);
    return { length: Math.min(maximum, TEXT_BLOCK_MAXIMUMS.renderedLength) };
  };

  const overflowCandidates = texts.flatMap((text) => {
    const baseline = estimateText(text, [], false).length;
    if (baseline > TEXT_BLOCK_MAXIMUMS.renderedLength) return [];
    const expanded = estimateText(text, [], true);
    if (expanded.length <= TEXT_BLOCK_MAXIMUMS.renderedLength) return [];
    const expandedNames = expanded.embeddedBlocks.filter((name, index, names) => names.indexOf(name) === index);
    return expandedNames.length === 0 ? [] : [{ length: expanded.length, blockNames: expandedNames }];
  });
  if (overflowCandidates.length === 0) return null;

  const length = Math.max(...overflowCandidates.map((candidate) => candidate.length));
  const blockNames = [...new Set(overflowCandidates.flatMap((candidate) => candidate.blockNames))];
  return { length, blockNames };
};
