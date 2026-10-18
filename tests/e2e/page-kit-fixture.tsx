/* eslint-disable react-refresh/only-export-components -- These fixture components are rendered by the test page, not hot-reloaded. */
import { createRoot } from "react-dom/client";
import { useState } from "react";

import { CollectionPage, PageHeader, SaveStatus, ToolPage, UiProvider } from "../../src/dashboard/ui";
import "../../src/dashboard/ui/core.css";
import "../../src/dashboard/overlay-editor.css";

const longGermanWord = "Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft".repeat(2);

function CollectionPageFixture() {
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

function ToolPageLayoutFixture() {
  const [dirty, setDirty] = useState(true);
  return <UiProvider>
    <main className="main-content page-kit-fixture" style={{ display: "flex", width: "100%", maxWidth: "none", height: "100dvh", padding: 16 }}>
      <ToolPage title="Overlay editor">
        <div className="overlay-editor">
          <div className="overlay-editor__workspace">
            <section className="overlay-editor__preview-panel" data-testid="sticky-preview">
              <h2>Live preview</h2>
              <div className="overlay-editor__preview-viewport" style={{ aspectRatio: "16 / 9" }}>
                <div style={{ height: 220 }}>Preview canvas</div>
              </div>
            </section>
            <section className="overlay-editor__properties" style={{ minHeight: 1800 }}>
              <h2>Properties</h2>
              <input aria-label="Editor field" data-testid="tool-field" />
              {Array.from({ length: 24 }, (_, index) => <p key={index}>Long editor field {index + 1}</p>)}
            </section>
            <section className="overlay-editor__elements"><h2>Elements</h2></section>
          </div>
          <SaveStatus dirty={dirty} persistent saveLabel="Save" discardLabel="Discard" savedLabel="Saved." pendingLabel="Saving …" onSave={() => { setDirty(false); }} onDiscard={() => { setDirty(false); }} />
        </div>
      </ToolPage>
    </main>
  </UiProvider>;
}

const fixture = new URLSearchParams(window.location.search).has("tool")
  ? <ToolPageLayoutFixture />
  : <CollectionPageFixture />;

createRoot(document.getElementById("root") as HTMLElement).render(fixture);
