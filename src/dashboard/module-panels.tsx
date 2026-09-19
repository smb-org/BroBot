import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { PanelActiveModule, PanelChannelRole, PanelModuleState } from "../panel-contract";
import { dashboardLanguage, dashboardTexte, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, type DashboardRoute } from "./router";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();

interface ModuleCatalogEntry {
  name: string;
  description: string;
}

interface ModuleWorkspaceTexte {
  status: string;
  hauptschalter: string;
  inhalt: string;
  unbekannt: (name: string) => string;
  nichtAktiv: (name: string) => string;
  ausgeschaltet: (name: string) => string;
  keineBeschreibung: string;
}

const workspaceKatalog: LocaleCatalog<ModuleWorkspaceTexte> = {
  de: {
    status: "Modulstatus",
    hauptschalter: "Hauptschalter",
    inhalt: "Modulinhalt",
    unbekannt: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    nichtAktiv: (name) => `Das Modul „${name}“ ist in diesem Kanal nicht aktiv.`,
    ausgeschaltet: (name) => `Das Modul „${name}“ ist ausgeschaltet.`,
    keineBeschreibung: "Keine Beschreibung für dieses Modul.",
  },
  en: {
    status: "Module status",
    hauptschalter: "Main switch",
    inhalt: "Module content",
    unbekannt: (name) => `The module “${name}” is unknown.`,
    nichtAktiv: (name) => `The module “${name}” is not active in this channel.`,
    ausgeschaltet: (name) => `The module “${name}” is switched off.`,
    keineBeschreibung: "No description is available for this module.",
  },
};

const workspaceTexte = (language: DashboardLanguage = dashboardLanguage()): ModuleWorkspaceTexte => workspaceKatalog[language];

const moduleCatalog: LocaleCatalog<Record<string, ModuleCatalogEntry>> = {
  de: {
    textbefehle: {
      name: "Textbefehle",
      description: "Antwortet auf kurze Befehle im Chat.",
    },
  },
  en: {
    textbefehle: {
      name: "Text commands",
      description: "Replies to short commands in chat.",
    },
  },
};

const moduleDetails = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): ModuleCatalogEntry =>
  moduleCatalog[language][moduleId] ?? {
    name: moduleName(moduleId, language),
    description: workspaceTexte(language).keineBeschreibung,
  };

const iconFor = (moduleId: string): ReactElement => (
  <svg className="module-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {moduleId === "textbefehle" ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v10M8.5 10.5h7M8.5 13.5h5" /></> : <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 12h6M12 9v6" /></>}
  </svg>
);

const Led = ({ enabled, label }: { enabled: boolean; label: string }): ReactElement => (
  <span className="led" data-status={enabled ? "green" : "off"}>
    <span className="led__dot" aria-hidden="true" />
    <span>{label}</span>
  </span>
);

const ModuleTaste = ({ channelId, moduleId, enabled, onNavigate }: {
  channelId: string;
  moduleId: string;
  enabled: boolean;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const details = moduleDetails(moduleId);
  const route: DashboardRoute = { kind: "module", channelId, moduleId };
  const label = `${details.name} · ${statusWord(enabled)}`;
  return (
    <a
      className="module-taste"
      href={dashboardRoutePath(route)}
      aria-label={label}
      data-enabled={enabled ? "true" : "false"}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(route);
      }}
    >
      <span className="module-taste__icon" aria-hidden="true">{iconFor(moduleId)}</span>
      <strong>{details.name}</strong>
      <Led enabled={enabled} label={statusWord(enabled)} />
    </a>
  );
};

const ModuleSwitch = ({ moduleId, enabled, disabled, busy, onToggle }: {
  moduleId: string;
  enabled: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: () => void;
}): ReactElement => (
  <button
    className="switch"
    type="button"
    role="switch"
    aria-label={`${moduleDetails(moduleId).name}: ${statusWord(enabled)}`}
    aria-checked={enabled}
    aria-busy={busy}
    disabled={disabled || busy}
    onClick={onToggle}
  >
    <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
  </button>
);

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
    <nav className="primary-nav module-navigation" aria-label={texte.module.modul}>
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

interface ModuleWorkspaceProperties {
  channelId: string;
  ownRole: PanelChannelRole;
  modules: PanelModuleState[];
  loading?: boolean;
  error?: string | null;
  onNavigate: (route: DashboardRoute) => void;
}

export const ModuleWorkspace = ({ channelId, modules, loading = false, error = null, onNavigate }: ModuleWorkspaceProperties): ReactElement => {
  const registeredModules = MODULES.map((module) => ({
    id: module.id,
    enabled: modules.find((moduleState) => moduleState.id === module.id)?.enabled === true,
  }));

  return (
    <section className="module-workspace" aria-label={dashboardTexte().navigation.module}>
      <div className="module-workspace__main">
        <header className="module-workspace__heading">
          <h1>{dashboardTexte().navigation.module}</h1>
          {loading ? <span className="muted">{dashboardTexte().module.laden}</span> : null}
        </header>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        <div className="module-grid">
          {registeredModules.map(({ id, enabled }) => <ModuleTaste key={id} channelId={channelId} moduleId={id} enabled={enabled} onNavigate={onNavigate} />)}
        </div>
      </div>
    </section>
  );
};

const canManageModules = (role: PanelChannelRole): boolean => role !== "bediener";

const ModuleListLink = ({ channelId, onNavigate }: { channelId: string; onNavigate: (route: DashboardRoute) => void }): ReactElement => {
  const route: DashboardRoute = { kind: "channel", channelId, section: "modules" };
  return (
    <a
      className="breadcrumb__link"
      href={dashboardRoutePath(route)}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(route);
      }}
    >
      {dashboardTexte().navigation.module}
    </a>
  );
};

interface ModulePageProperties {
  channelId: string;
  moduleId: string;
  ownRole: PanelChannelRole;
  modules: PanelModuleState[];
  activeModules: PanelActiveModule[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  onNavigate: (route: DashboardRoute) => void;
  onToggle: () => void;
}

export const ModulePage = ({ channelId, moduleId, ownRole, modules, activeModules, loading = false, error = null, busy = false, onNavigate, onToggle }: ModulePageProperties): ReactElement => {
  const texte = dashboardTexte();
  const labels = workspaceTexte();
  const details = moduleDetails(moduleId);
  const registered = MODULES.find((candidate) => candidate.id === moduleId);
  const moduleState = modules.find((candidate) => candidate.id === moduleId);
  const activeModule = activeModules.find((candidate) => candidate.moduleId === moduleId);
  const enabled = moduleState?.enabled ?? activeModule !== undefined;
  const manageable = canManageModules(ownRole);
  const disabledReason = manageable ? null : texte.module.verwaltungGesperrt;
  const switchDisabled = registered === undefined || (moduleState === undefined && activeModule === undefined);

  const stateMessage = registered === undefined
    ? labels.unbekannt(details.name)
    : moduleState?.enabled === false
      ? labels.ausgeschaltet(details.name)
      : activeModule === undefined
        ? labels.nichtAktiv(details.name)
        : null;
  const stateTone = registered === undefined || (moduleState?.enabled !== false && activeModule === undefined) ? "notice" : "neutral";

  return (
    <>
      <header className="page-heading module-detail-heading">
        <nav className="breadcrumb" aria-label={texte.navigation.module}>
          <ModuleListLink channelId={channelId} onNavigate={onNavigate} />
          <span className="breadcrumb__separator" aria-hidden="true">›</span>
          <span className="breadcrumb__current" aria-current="page">
            <span className="breadcrumb__icon">{iconFor(moduleId)}</span>
            <span>{details.name}</span>
          </span>
        </nav>
      </header>
      <section className="module-detail" aria-label={details.name}>
        <header className="module-detail__header">
          <div className="module-detail__icon" aria-hidden="true">{iconFor(moduleId)}</div>
          <div>
            <h1>{details.name}</h1>
            <p className="module-detail__id">{moduleId}</p>
            <p className="module-detail__description">{details.description}</p>
          </div>
        </header>
        <section className="module-detail__switch inspector-section--switch" aria-label={labels.status}>
          <div>
            <strong>{labels.hauptschalter}</strong>
            <Led enabled={enabled} label={statusWord(enabled)} />
          </div>
          <ModuleSwitch moduleId={moduleId} enabled={enabled} disabled={!manageable || switchDisabled} busy={busy} onToggle={onToggle} />
          {disabledReason === null ? null : <p className="sperrgrund">{disabledReason}</p>}
        </section>
        {loading ? <p className="muted">{texte.module.laden}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {stateMessage === null ? (
          registered?.panel === undefined ? <p className="module-state">{texte.module.keineAnsicht}</p> : (
            <section className="module-detail__content" aria-label={labels.inhalt}>
              <ModulePanelMount channelId={channelId} activeModules={[activeModule as PanelActiveModule]} />
            </section>
          )
        ) : (
          <section className={`module-state module-state--${stateTone}`} aria-label={texte.module.modul}>
            <p>{stateMessage}</p>
            <ModuleListLink channelId={channelId} onNavigate={onNavigate} />
          </section>
        )}
      </section>
    </>
  );
};
