/* eslint-disable react-refresh/only-export-components -- Browser fixture entry point. */
import { useState } from "react";
import { createRoot } from "react-dom/client";

import { SettingsEditor, UiProvider } from "../../src/dashboard/ui";
import { OverlayCanvas } from "../../src/overlay/canvas";
import type { BoundOverlayData } from "../../src/overlay/model";
import type { JsonObject } from "../../src/modules/contract";
import { DEFAULT_VOTEKICK_SETTINGS } from "../../src/modules/votekick/contracts";
import { votekickSettingsEditorCatalog } from "../../src/modules/votekick/panel/locale";
import settingsEditor from "../../src/modules/votekick/panel/settings-editor";

const initialNow = Date.now();
const initialState: JsonObject = {
  votekickId: "fixture-ballot",
  targetLogin: "sampleviewer",
  targetUserId: "fixture-target",
  yesVotes: 4,
  noVotes: 1,
  threshold: 5,
  ballotRevision: 5,
  status: "running",
  startedAt: new Date(initialNow).toISOString(),
  endsAt: new Date(initialNow + 2_000).toISOString(),
  endedAt: null,
};

const overlay: BoundOverlayData = {
  id: "votekick-fixture",
  revision: 1,
  width: 480,
  height: 220,
  css: "",
  elements: [{
    id: "votekick-tally",
    kind: "votekick.tally",
    label: "Votekick result",
    variableName: null,
    text: "",
    x: 0,
    y: 0,
    scalePercent: 100,
    z: 0,
    inComposition: true,
    moduleEnabled: true,
    config: { showCountdown: true, hideAfterCloseSeconds: 1 },
    state: initialState,
  }],
};

document.body.style.margin = "0";

const App = () => {
  const [state, setState] = useState<JsonObject>(initialState);
  const [settings, setSettings] = useState(DEFAULT_VOTEKICK_SETTINGS);
  const copy = votekickSettingsEditorCatalog("en");
  const currentOverlay: BoundOverlayData = {
    ...overlay,
    elements: overlay.elements.map((element) => element.id === "votekick-tally" ? { ...element, state } : element),
  };

  return <UiProvider>
    <main>
      <OverlayCanvas overlay={currentOverlay} language="en" variables={{}} elementId={null} />
      <button type="button" onClick={() => setState((current) => ({
        ...current,
        status: "passed",
        endedAt: new Date(Date.now()).toISOString(),
      }))}>Close as passed</button>
      <SettingsEditor
        spec={settingsEditor.spec}
        sectionId="thresholds"
        settings={settings}
        onChange={(key, next) => { setSettings((current) => ({ ...current, [key]: next })); }}
        texts={copy}
        templateMessages={copy.templateMessages}
      />
      <output data-testid="starter-role-value">{settings.starterMinRole}</output>
    </main>
  </UiProvider>;
};

createRoot(document.getElementById("root") as HTMLElement).render(<App />);
