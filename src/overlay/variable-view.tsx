import type { ReactElement } from "react";

import { formatCount } from "../text";
import { channelVariableTemplateToken } from "../contracts/channel-variable-template";
import type { OverlayLanguage } from "./model";
import "./variable.css";

interface VariableValueViewProperties {
  name: string;
  text: string;
  value: number;
  language: OverlayLanguage;
  variables?: Readonly<Record<string, number>>;
}

/** Renders a variable as text while keeping the public overlay classes stable. */
export const VariableValueView = ({ name, text, value, language, variables = {} }: VariableValueViewProperties): ReactElement => {
  const ownValue = formatCount(value, language);
  const ownToken = channelVariableTemplateToken(name);
  const expression = /\{var\.([a-z][a-z0-9_]{0,31})\}|\{value\}/gu;
  const segments: { kind: "text" | "value"; text: string }[] = [];
  let offset = 0;
  let hasOwnValue = false;
  for (const match of text.matchAll(expression)) {
    const token = match[0];
    const tokenIndex = match.index;
    if (tokenIndex > offset) segments.push({ kind: "text", text: text.slice(offset, tokenIndex) });
    const variableName = match[1];
    const tokenValue = token === "{value}"
      ? value
      : variableName === name
        ? value
        : variableName === undefined || !Object.hasOwn(variables, variableName) ? undefined : variables[variableName];
    if (tokenValue === undefined) segments.push({ kind: "text", text: token });
    else {
      segments.push({ kind: "value", text: formatCount(tokenValue, language) });
      if (token === "{value}" || token === ownToken) hasOwnValue = true;
    }
    offset = tokenIndex + token.length;
  }
  if (offset < text.length || segments.length === 0) segments.push({ kind: "text", text: text.slice(offset) });
  if (!hasOwnValue) {
    if (text.length > 0) segments.push({ kind: "text", text: " " });
    segments.push({ kind: "value", text: ownValue });
  }

  return <div className="brobot-variable" data-variable={name}>
    {segments.map((segment, index) => <span className={segment.kind === "value" ? "brobot-variable__value" : "brobot-variable__text"} key={`${String(index)}:${segment.kind}`}>{segment.text}</span>)}
  </div>;
};
