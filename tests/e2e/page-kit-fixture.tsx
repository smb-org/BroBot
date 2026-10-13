import { createRoot } from "react-dom/client";
import { useState } from "react";

import { CollectionPage, PageHeader, SaveStatus, UiProvider } from "../../src/dashboard/ui";
import "../../src/dashboard/styles.css";

const longGermanWord = "Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft".repeat(2);

export function PageKitFixture() {
  const [dirty, setDirty] = useState(true);
  const [saved, setSaved] = useState(false);
  const save = (): void => {
    setDirty(false);
    setSaved(true);
  };
  const discard = (): void => {
    setDirty(false);
    setSaved(false);
  };

  return (
    <UiProvider>
      <main className="main-content page-kit-fixture" style={{ display: "flex", width: "100%", maxWidth: "none", height: "100dvh", padding: 16 }}>
        <CollectionPage
          title={longGermanWord}
          toolbar={<button type="button">Filter</button>}
          list={<div style={{ minHeight: 1200 }}><p>{longGermanWord}</p><p>{longGermanWord}</p></div>}
          detail={<div>
            <PageHeader
              kind="modules"
              title={longGermanWord}
              subtitle={longGermanWord}
              active
              onToggle={() => undefined}
              badge={<span>{longGermanWord}</span>}
              saveStatus={<SaveStatus dirty={dirty} saved={saved} persistent onSave={save} onDiscard={discard} saveLabel="Save" discardLabel="Discard" savedLabel="Saved." pendingLabel="Saving …" />}
              pageActions={<button type="button">Open details</button>}
            />
            <div style={{ minHeight: 1200 }}><p>{longGermanWord}</p><p>{longGermanWord}</p></div>
          </div>}
        />
      </main>
    </UiProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<PageKitFixture />);
