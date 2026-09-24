import type { ReactElement } from "react";

import { tokenizeTemplate, type TemplateVariable } from "../../template";
import type { TemplateVariableOption } from "./TextArea";

export interface TemplateTextProps {
  value: string;
  variables: readonly TemplateVariableOption[];
  className?: string;
}

export function TemplateText({ value, variables, className }: TemplateTextProps): ReactElement {
  const declarations: TemplateVariable[] = variables.map(({ name, sample, group, kind, parameters, external }) => ({
    name,
    sample,
    maxLength: 0,
    group: group ?? "context",
    source: kind ?? "module",
    ...(parameters === undefined ? {} : { parameters }),
    ...(external === undefined ? {} : { external }),
  }));
  const pieces = tokenizeTemplate(value, declarations);
  return (
    <span className={`ui-template-text${className === undefined ? "" : ` ${className}`}`}>
      {pieces.map((piece) => <span key={`${String(piece.start)}-${piece.kind}`} data-kind={piece.kind}>{piece.text}</span>)}
    </span>
  );
}
