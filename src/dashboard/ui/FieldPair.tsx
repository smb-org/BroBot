import type { ReactElement, ReactNode } from "react";

export interface FieldPairProps {
  children: readonly [ReactNode, ReactNode];
}

export function FieldPair({ children }: FieldPairProps): ReactElement {
  return <div className="ui-field-pair">{children[0]}{children[1]}</div>;
}
