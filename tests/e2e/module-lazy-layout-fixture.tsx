import { createRoot } from "react-dom/client";

import { MODULES } from "../../src/modules/registry";
import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { ModuleOverlayElementEditor } from "../../src/dashboard/ModuleOverlayElementEditor";
import { ModulePanelMount } from "../../src/dashboard/module-panels";
import { UiProvider } from "../../src/dashboard/ui";
import { MODULE_OVERLAY_ELEMENTS } from "../../src/modules/overlay-element-registry";
import "../../src/dashboard/styles.css";

const channelId = "channel-a";
const query = new URLSearchParams(window.location.search);
const moduleId = query.get("module");
const elementKind = query.get("element");
const module = MODULES.find((candidate) => candidate.id === moduleId);
const element = MODULE_OVERLAY_ELEMENTS.find((candidate) => candidate.definition.kind === elementKind);

const content = element !== undefined
  ? <div className="module-route-layout" data-testid="module-route-layout">
    <ModuleOverlayElementEditor
      kind={element.definition.kind}
      config={element.definition.defaultConfig}
      channelId={channelId}
      language="en"
      onChange={() => undefined}
    />
  </div>
    : module === undefined
    ? <p>Unknown lazy view.</p>
    : <div className="module-route-layout" data-testid="module-route-layout">
      <ModulePanelMount
        channelId={channelId}
        activeModules={[{ moduleId: module.id, settings: "{}" }]}
      />
    </div>;

createRoot(document.getElementById("root") as HTMLElement).render(
  <DashboardDataProvider>
    <UiProvider>
      <main className="main-content" style={{ width: "min(960px, 100%)", padding: "16px" }}>
        {content}
      </main>
    </UiProvider>
  </DashboardDataProvider>,
);
