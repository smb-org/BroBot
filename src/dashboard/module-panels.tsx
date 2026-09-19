import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { PanelActiveModule } from "../panel-contract";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();

const getLazyPanel = (module: (typeof MODULES)[number]): LazyExoticComponent<ComponentType<ModulePanelProperties>> | null => {
  if (module.panel === undefined) return null;
  const existing = lazyPanels.get(module.id);
  if (existing !== undefined) return existing;
  const panel = lazy(module.panel);
  lazyPanels.set(module.id, panel);
  return panel;
};

interface ModulePanelMountProperties {
  channelId: string;
  activeModules: PanelActiveModule[];
}

export const ModulePanelMount = ({ channelId, activeModules }: ModulePanelMountProperties): ReactElement => {
  const registeredPanels = activeModules.flatMap((activeModule) => {
    const module = MODULES.find((candidate) => candidate.id === activeModule.moduleId);
    if (module === undefined) return [];
    const panel = getLazyPanel(module);
    return panel === null ? [] : [{ id: activeModule.moduleId, Panel: panel }];
  });

  if (registeredPanels.length === 0) {
    return (
      <section className="module-empty" aria-label="Module">
        <p>{activeModules.length === 0 ? "Keine Module aktiv." : "Für die aktiven Module gibt es noch keine Panel-Ansicht."}</p>
      </section>
    );
  }

  return (
    <section className="module-stack" aria-label="Modulansichten">
      <Suspense fallback={<p className="muted">Modulansichten werden geladen …</p>}>
        {registeredPanels.map(({ id, Panel }) => <Panel key={id} channelId={channelId} />)}
      </Suspense>
    </section>
  );
};
