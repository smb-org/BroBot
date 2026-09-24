import type { ReactElement } from "react";

import { formatCount } from "../text";
import type { OverlayLanguage } from "./model";
import "./variable.css";

interface VariableValueViewProperties {
  name: string;
  text: string;
  value: number;
  language: OverlayLanguage;
}

/** Renders a variable as text while keeping the public overlay classes stable. */
export const VariableValueView = ({ name, text, value, language }: VariableValueViewProperties): ReactElement => {
  const formatted = formatCount(value, language);
  const placeholderIndex = text.indexOf("{value}");
  const before = placeholderIndex === -1
    ? text.length === 0 ? "" : `${text} `
    : text.slice(0, placeholderIndex);
  const after = placeholderIndex === -1 ? "" : text.slice(placeholderIndex + "{value}".length);

  return <div className="brobot-variable" data-variable={name}>
    <span className="brobot-variable__text">{before}</span>
    <span className="brobot-variable__value">{formatted}</span>
    {after.length === 0 ? null : <span className="brobot-variable__text">{after}</span>}
  </div>;
};
