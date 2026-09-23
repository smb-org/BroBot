import { tokenizeTemplate, type TemplateVariable } from "../../template";

export interface TemplateHighlightQuery {
  start: number;
  end: number;
}

export interface TemplateHighlightPart {
  kind: "text" | "known" | "unknown" | "suggestion";
  text: string;
  start: number;
}

export const templateHighlightParts = (
  value: string,
  declarations: readonly TemplateVariable[],
  query: TemplateHighlightQuery | null = null,
): TemplateHighlightPart[] => {
  const parts: TemplateHighlightPart[] = [];
  const openBrace = query === null ? -1 : query.start - 1;
  for (const part of tokenizeTemplate(value, declarations)) {
    const start = part.start;
    const end = start + part.text.length;
    if (query === null || query.end <= start || openBrace >= end) {
      parts.push({ kind: part.kind, text: part.text, start });
      continue;
    }
    const actualStart = Math.max(start, openBrace);
    if (actualStart > start) parts.push({ kind: part.kind, text: value.slice(start, actualStart), start });
    const fragmentEnd = Math.min(end, query.end);
    if (fragmentEnd > actualStart) parts.push({ kind: "suggestion", text: value.slice(actualStart, fragmentEnd), start: actualStart });
    if (end > fragmentEnd) parts.push({ kind: part.kind, text: value.slice(fragmentEnd, end), start: fragmentEnd });
  }
  return parts;
};
