import { createRoot } from "react-dom/client";

import { EditorShell, GroupedPicker, UiProvider } from "../../src/dashboard/ui";

const messages = {
  title: "Element auswählen",
  searchLabel: "Element suchen",
  closeLabel: "Schließen",
  noResults: "Keine Elemente gefunden.",
  keyHints: { navigate: "Navigieren", choose: "Auswählen", close: "Schließen" },
};

const pickerGroups = [{
  id: "elements",
  label: "Elemente",
  icon: <span aria-hidden="true">•</span>,
  entries: [{ id: "title", label: "Titel", description: "Zeigt den aktuellen Streamtitel.", icon: <span aria-hidden="true">T</span> }],
}];

const invalidFields = [
  { id: "title", label: "Titel", message: "Gib einen Titel ein.", sectionId: "settings" },
  { id: "game", label: "Spiel", message: "Wähle ein Spiel aus der Liste aus.", sectionId: "settings" },
  { id: "duration", label: "Dauer", message: "Die Dauer muss zwischen 1 und 60 Minuten liegen.", sectionId: "settings" },
];

export function Issue440PopoversFixture() {
  return (
    <UiProvider>
      <main style={{ display: "grid", gap: "24px", padding: "32px", maxWidth: "800px" }}>
        <GroupedPicker
          groups={pickerGroups}
          messages={messages}
          trigger={<button type="button">Element hinzufügen</button>}
          onSelect={() => {}}
          defaultOpened
        />
        <EditorShell
          ariaLabel="Einstellungen"
          title="Einstellungen"
          dirty
          invalid
          invalidMessage="Bitte korrigiere das markierte Feld."
          invalidFields={invalidFields}
          sections={[{ id: "settings", label: "Einstellungen", content: <p>Formularinhalt</p> }]}
          onSave={() => {}}
          onDiscard={() => {}}
          saveLabel="Speichern"
          discardLabel="Verwerfen"
          savedLabel="Gespeichert."
          pendingLabel="Speichern …"
          issueLabels={{ error: "Fehler", warning: "Warnung" }}
        />
      </main>
    </UiProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Issue440PopoversFixture />);
