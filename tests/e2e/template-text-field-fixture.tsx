import { createRoot } from "react-dom/client";
import { useState } from "react";

import { TemplateTextField, UiProvider, type TemplateTextFieldMessages, type TemplateTextFieldVariable } from "../../src/dashboard/ui";
import { apiSourcePanelTexts } from "../../src/modules/api_source/panel/locale";
import { ExpressionField } from "../../src/modules/api_source/panel/ExpressionField";
import "../../src/dashboard/ui/tokens.css";

const variables: readonly TemplateTextFieldVariable[] = [
  { name: "user", label: "Username", description: "The triggering viewer", sample: "nachtfalke", kind: "module" },
  { name: "user", label: "Duplicate username", description: "Duplicate declaration", sample: "duplicated", kind: "module" },
  { name: "viewers", label: "Viewer count", description: "Current viewer count", sample: "42", kind: "module" },
];

const messages: TemplateTextFieldMessages = {
  countLabel: (count, maximum) => `${String(count)} / ${String(maximum)}`,
  previewCountLabel: (count) => `${String(count)} characters`,
  openBrace: "Unclosed variable: add a closing brace }.",
  unknownVariable: (name, suggestion) => suggestion === null ? `Unknown variable {${name}}.` : `Unknown variable {${name}} — did you mean {${suggestion}}?`,
  insertSuggestionLabel: (name) => `Insert {${name}}`,
  worstCaseLength: (length, maximum) => `${String(length)} / ${String(maximum)}`,
  picker: {
    title: "Choose a variable",
    noResults: "No variables found.",
    externalHelp: "Looks up live data from Twitch when the template runs",
    groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
    keyHints: { navigate: "select", insert: "insert", close: "close" },
  },
};

export function TemplateTextFieldFixture() {
  const [value, setValue] = useState("");
  const [expression, setExpression] = useState("");
  return <UiProvider>
    <main style={{ width: "min(720px, 100%)", padding: 16 }}>
      <TemplateTextField label="Reply" hint="Type a brace to choose a variable." value={value} onChange={setValue} variables={variables} messages={messages} minRows={3} />
      <p id="content-below-picker">This content stays in place while the picker is open.</p>
      <ExpressionField id="expression" label="JSONata expression" value={expression} onChange={setExpression} maxLength={512} language="en" messages={apiSourcePanelTexts("en").expressionPicker} />
      <p id="content-below-expression">This content stays in place while function suggestions are open.</p>
    </main>
  </UiProvider>;
}

createRoot(document.getElementById("root") as HTMLElement).render(<TemplateTextFieldFixture />);
