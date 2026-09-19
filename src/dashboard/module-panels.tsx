import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { PanelActiveModule } from "../panel-contract";
import { dashboardLanguage, dashboardTexte } from "./locale";

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
    const texte = dashboardTexte();
    return (
      <section className="module-empty" aria-label={texte.module.modul}>
        <p>{activeModules.length === 0 ? texte.module.keineAktiv : texte.module.keineAnsicht}</p>
      </section>
    );
  }

  return (
    <section className="module-stack" aria-label={dashboardTexte().module.ansichten}>
      <Suspense fallback={<p className="muted">{dashboardTexte().module.ansichtenLaden}</p>}>
        {registeredPanels.map(({ id, Panel }) => <Panel key={id} channelId={channelId} language={dashboardLanguage()} />)}
      </Suspense>
    </section>
  );
};
