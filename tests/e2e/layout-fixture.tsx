import { createRoot } from "react-dom/client";
import { useState } from "react";

import { Field, FormDialog, GamePicker, NumberField, SaveBar, Select, TagInput, TextArea, UiProvider, type GamePickerGame } from "../../src/dashboard/ui";
import type { TextAreaMessages } from "../../src/dashboard/ui";
import "../../src/dashboard/styles.css";

const textAreaMessages: TextAreaMessages = {
  countLabel: (count, max) => `${String(count)}/${String(max)}`,
  previewCountLabel: (count) => `${String(count)} characters`,
  unknownVariable: (name) => `Unknown variable {${name}}.`,
  insertSuggestionLabel: (name) => `Insert {${name}}`,
  worstCaseLength: (length, max) => `${String(length)} exceeds ${String(max)} characters.`,
};

const gamePickerMessages = {
  label: "Games",
  hint: "Add one or more games.",
  search: "Search games",
  searchHint: "Type at least two characters.",
  loading: "Searching games …",
  empty: "No games found.",
  error: "Games could not be loaded.",
  remove: (name: string) => `Remove ${name}`,
};

const fixtureGames: GamePickerGame[] = [
  { id: "game-one", name: "Game One" },
];

const searchFixtureGames = (): Promise<readonly GamePickerGame[]> => Promise.resolve(fixtureGames);

export function LayoutFixture() {
  const [showIssues, setShowIssues] = useState(false);
  const [previewLong, setPreviewLong] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [games, setGames] = useState<GamePickerGame[]>([]);
  const [number, setNumber] = useState<number | "">(4);
  const errorProps = showIssues ? { error: "A validation error." } : {};

  return (
    <UiProvider>
      <main className="main-content" style={{ width: "min(960px, 100%)", padding: "16px" }}>
        <button id="toggle-issues" type="button" onClick={() => { setShowIssues((current) => !current); }}>Toggle issues</button>
        <button id="toggle-preview" type="button" onClick={() => { setPreviewLong((current) => !current); }}>Toggle preview</button>
        <button id="toggle-save-pending" type="button" onClick={() => { setSavePending((current) => !current); }}>Toggle save pending</button>
        <button id="open-dialog" type="button" onClick={() => { setDialogOpen(true); }}>Open dialog</button>
        <div className="layout-fixture__game-picker">
          <GamePicker searchGames={searchFixtureGames} value={games} onChange={setGames} messages={gamePickerMessages} />
          <button id="game-picker-outside-control" type="button">Check message</button>
        </div>
        <div className="layout-fixture__compact-header" style={{ display: "flex", alignItems: "center", width: 320, height: 44 }}>
          <Select id="layout-header-channel" compact ariaLabel="Header channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="A reserved header hint." {...(showIssues ? { error: "A reserved header error." } : {})} />
        </div>
        <div className="module-stack">
          <Field id="layout-name" label="Name" hint="A short name." value="hello" onChange={() => {}} {...errorProps} maxLength={30} countLabel={(count, max) => `${String(count)}/${String(max)}`} />
          <NumberField id="layout-number" label="Count" hint="A short count." value={number} onChange={setNumber} {...errorProps} />
          <NumberField id="layout-stepper" label="Stepped count" hint="A short stepped count." value={number} onChange={setNumber} {...errorProps} min={0} max={10} step={1} increaseLabel="Increase" decreaseLabel="Decrease" />
          <Select id="layout-select" label="Mode" hint="A short mode." value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} {...errorProps} />
          <TagInput id="layout-tags" label="Aliases" hint="A short alias hint." value={tags} onChange={setTags} {...(showIssues ? { error: "A validation error that should remain on one line beside its marker and not cover the warning row." } : {})} {...(showIssues ? { warning: "A duplicate warning that should remain in its own one-line row." } : {})} removeLabel={(entry) => `Remove ${entry}`} listLabel="Alias list" messages={{ countLabel: (count, max) => `${String(count)}/${String(max)}`, atLimitHint: "At limit.", duplicateWarning: (entry) => `${entry} is duplicated.` }} />
          <TextArea id="layout-template" label="Reply" hint="A short reply hint." value={showIssues ? "Hi {missing}" : "Hi there"} onChange={() => {}} {...errorProps} variables={[]} preview={(text) => previewLong ? `${text} ${"long preview ".repeat(30)}` : text} previewLabel="Preview" previewSpeaker="Bot" messages={textAreaMessages} />
        </div>
        <SaveBar dirty={showIssues} pending={savePending} persistent saveLabel="Save" discardLabel="Discard" savedLabel="Saved." pendingLabel="Saving settings …" onSave={() => {}} onDiscard={() => {}} />
      </main>
      <FormDialog opened={dialogOpen} title="Layout dialog" children={<button type="button" onClick={() => { setDialogError((current) => !current); }}>Toggle dialog error</button>} confirmLabel="Save" cancelLabel="Cancel" onConfirm={() => {}} onCancel={() => { setDialogOpen(false); }} {...(dialogError ? { error: "A dialog error. This explains the complete reason and the step needed to correct the request." } : {})} />
    </UiProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<LayoutFixture />);
