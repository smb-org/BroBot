import { createRoot } from "react-dom/client";
import { useState } from "react";

import { ChipsInput, Field, FormDialog, GameMultiSelect, SaveBar, Select, TemplateTextField, UiProvider, UnitInput, type GameMultiSelectGame, type TemplateTextFieldMessages } from "../../src/dashboard/ui";
import "../../src/dashboard/ui/tokens.css";

const templateMessages: TemplateTextFieldMessages = {
  countLabel: (count, max) => `${String(count)}/${String(max)}`,
  previewCountLabel: (count) => `${String(count)} characters`,
  openBrace: "Unclosed variable: add a closing brace }.",
  unknownVariable: (name) => `Unknown variable {${name}}.`,
  insertSuggestionLabel: (name) => `Insert {${name}}`,
  insertionLimit: "This insertion would exceed the character limit.",
  worstCaseLength: (length, max) => `${String(length)} exceeds ${String(max)} characters.`,
  picker: {
    title: "Choose a variable",
    noResults: "No variables found.",
    externalHelp: "Looks up live data from Twitch when the template runs",
    groupLabels: { module: "This module", channel: "Channel", own: "Own variables", text_blocks: "Text blocks" },
    keyHints: { navigate: "select", insert: "insert", close: "close" },
  },
};

const gameMultiSelectMessages = {
  label: "Games",
  hint: "Add one or more games.",
  search: "Search games",
  searchHint: "Type at least two characters.",
  loading: "Searching games …",
  empty: "No games found.",
  error: "Games could not be loaded.",
  suggestions: "Suggestions",
  allGames: "All games",
  selectedCount: (count: number, maximum: number) => `${String(count)} of ${String(maximum)}`,
  remove: (name: string) => `Remove ${name}`,
};

const fixtureGames: GameMultiSelectGame[] = [
  { id: "game-one", name: "Game One" },
];

const searchFixtureGames = (): Promise<readonly GameMultiSelectGame[]> => Promise.resolve(fixtureGames);

export function LayoutFixture() {
  const [showIssues, setShowIssues] = useState(false);
  const [previewLong, setPreviewLong] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [games, setGames] = useState<GameMultiSelectGame[]>([]);
  const [number, setNumber] = useState<number | "">(4);
  const longError = new URLSearchParams(window.location.search).has("longError");
  const errorProps = showIssues ? { error: longError ? "A server error that is long enough to need several lines on a narrow screen and must stay fully readable." : "A validation error." } : {};

  return (
    <UiProvider>
      <main className="main-content" style={{ width: "min(960px, 100%)", padding: "16px" }}>
        <button id="toggle-issues" type="button" onClick={() => { setShowIssues((current) => !current); }}>Toggle issues</button>
        <button id="toggle-preview" type="button" onClick={() => { setPreviewLong((current) => !current); }}>Toggle preview</button>
        <button id="toggle-save-pending" type="button" onClick={() => { setSavePending((current) => !current); }}>Toggle save pending</button>
        <button id="open-dialog" type="button" onClick={() => { setDialogOpen(true); }}>Open dialog</button>
        <div className="layout-fixture__game-picker">
          <GameMultiSelect searchGames={searchFixtureGames} value={games} onChange={setGames} messages={gameMultiSelectMessages} />
          <button id="game-picker-outside-control" type="button">Check message</button>
        </div>
        <div className="layout-fixture__compact-header" style={{ display: "flex", alignItems: "center", width: 320, height: 44 }}>
          <Select id="layout-header-channel" compact ariaLabel="Header channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="A reserved header hint." {...(showIssues ? { error: "A reserved header error." } : {})} />
        </div>
        <div className="module-stack">
          <Field id="layout-name" label="Name" hint="A short name." value="hello" onChange={() => {}} {...errorProps} maxLength={30} countLabel={(count, max) => `${String(count)}/${String(max)}`} />
          <UnitInput id="layout-number" label="Count" hint="A short count." value={number} onChange={setNumber} {...errorProps} />
          <Select id="layout-select" label="Mode" hint="A short mode." value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} {...errorProps} />
          <ChipsInput id="layout-tags" label="Aliases" hint="A short alias hint." values={tags} onChange={setTags} {...(showIssues ? { error: "A validation error that should remain on one line beside its marker and not cover the warning row." } : {})} {...(showIssues ? { warning: "A duplicate warning that should remain in its own one-line row." } : {})} removeLabel={(entry) => `Remove ${entry}`} listLabel="Alias list" messages={{ countLabel: (count, max) => `${String(count)}/${String(max)}`, atLimitHint: "At limit.", duplicateWarning: (entry) => `${entry} is duplicated.` }} />
          <TemplateTextField id="layout-template" label="Reply" hint="A short reply hint." value={showIssues ? "Hi {missing}" : "Hi there"} onChange={() => {}} {...errorProps} variables={[]} preview={(text) => previewLong ? `${text} ${"long preview ".repeat(30)}` : text} previewLabel="Preview" previewSpeaker="Bot" messages={templateMessages} />
        </div>
        <SaveBar dirty={showIssues} pending={savePending} {...(showIssues ? { error: "The module settings are invalid." } : {})} persistent saveLabel="Save" discardLabel="Discard" savedLabel="Saved." pendingLabel="Saving settings …" onSave={() => {}} onDiscard={() => {}} />
      </main>
      <FormDialog opened={dialogOpen} title="Layout dialog" children={<button type="button" onClick={() => { setDialogError((current) => !current); }}>Toggle dialog error</button>} confirmLabel="Save" cancelLabel="Cancel" onConfirm={() => {}} onCancel={() => { setDialogOpen(false); }} {...(dialogError ? { error: "A dialog error. This explains the complete reason and the step needed to correct the request." } : {})} />
    </UiProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<LayoutFixture />);
