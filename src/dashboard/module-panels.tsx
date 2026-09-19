import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { PanelActiveModule } from "../panel-contract";
import { dashboardLanguage, dashboardTexte, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { dashboardRoutePath, type DashboardRoute } from "./router";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();

interface ModulNamen {
  textbefehle: string;
}

const modulNamen: LocaleCatalog<ModulNamen> = {
  de: { textbefehle: "Textbefehle" },
  en: { textbefehle: "Text commands" },
};

const moduleName = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): string => {
  if (moduleId === "textbefehle") return modulNamen[language].textbefehle;
  return moduleId;
};

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

interface ModuleNavigationProperties {
  channelId: string;
  activeModules: PanelActiveModule[];
  onNavigate: (route: DashboardRoute) => void;
}

export const ModuleNavigation = ({ channelId, activeModules, onNavigate }: ModuleNavigationProperties): ReactElement => {
  const texte = dashboardTexte();
  if (activeModules.length === 0) {
    return (
      <section className="module-empty" aria-label={texte.module.modul}>
        <p>{texte.module.keineAktiv}</p>
      </section>
    );
  }
  return (
    <nav className="primary-nav" aria-label={texte.module.modul}>
      {activeModules.map(({ moduleId }) => {
        const route: DashboardRoute = { kind: "module", channelId, moduleId };
        return (
          <a
            className="nav-link"
            href={dashboardRoutePath(route)}
            key={moduleId}
            onClick={(event) => {
              event.preventDefault();
              onNavigate(route);
            }}
          >
            {moduleName(moduleId)}
          </a>
        );
      })}
    </nav>
  );
};

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

interface ModulePageProperties {
  channelId: string;
  moduleId: string;
  activeModules: PanelActiveModule[];
}

export const ModulePage = ({ channelId, moduleId, activeModules }: ModulePageProperties): ReactElement => {
  const texte = dashboardTexte();
  const name = moduleName(moduleId);
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  const activeModule = activeModules.find((candidate) => candidate.moduleId === moduleId);

  return (
    <>
      <header className="page-heading">
        <h1>{name}</h1>
        <span className="muted mono">{moduleId}</span>
      </header>
      {module === undefined ? (
        <section className="module-empty" aria-label={texte.module.modul}>
          <p>{texte.module.unbekannt(name)}</p>
        </section>
      ) : activeModule === undefined ? (
        <section className="module-empty" aria-label={texte.module.modul}>
          <p>{texte.module.nichtAktiv(name)}</p>
        </section>
      ) : module.panel === undefined ? (
        <section className="module-empty" aria-label={texte.module.modul}>
          <p>{texte.module.keineAnsicht}</p>
        </section>
      ) : (
        <ModulePanelMount channelId={channelId} activeModules={[activeModule]} />
      )}
    </>
  );
};
