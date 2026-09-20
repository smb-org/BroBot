import { lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement, type ReactNode } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import type { PanelActiveModule, PanelChannelRole, PanelModuleState } from "../panel-contract";
import { dashboardLanguage, dashboardTexte, formatZahl, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { moduleDescription, moduleName, statusWord } from "./module-labels";
import { dashboardRoutePath, type DashboardRoute } from "./router";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();

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

const moduleDetails = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): { name: string; description: string } => ({
  name: moduleName(moduleId, language),
  description: moduleDescription(moduleId, language) ?? workspaceTexte(language).keineBeschreibung,
});

export type ZustandsTon = "healthy" | "warning" | "error" | "neutral";
export type LedStatus = "green" | "amber" | "red" | "off";

export const NavigationIcon = ({ kind, className = "navigation-icon" }: { kind: string; className?: string }): ReactElement => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {kind === "overview" ? <><rect x="5" y="5" width="5" height="5" rx="1" /><rect x="14" y="5" width="5" height="5" rx="1" /><rect x="5" y="14" width="5" height="5" rx="1" /><rect x="14" y="14" width="5" height="5" rx="1" /></> : kind === "channel" ? <><path d="M5 7.5h14M5 12h14M5 16.5h9" /><circle cx="18" cy="16.5" r="1" /></> : kind === "system" ? <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l2.5 2" /></> : kind === "members" ? <><circle cx="10" cy="9" r="3" /><path d="M4.5 18c.8-3 2.6-4.5 5.5-4.5s4.7 1.5 5.5 4.5M17 8.5a2.5 2.5 0 0 1 0 5" /></> : kind === "modules" ? <><rect x="5" y="5" width="6" height="6" rx="1" /><rect x="13" y="5" width="6" height="6" rx="1" /><rect x="5" y="13" width="6" height="6" rx="1" /><rect x="13" y="13" width="6" height="6" rx="1" /></> : <><path d="M6 5h12v14H6z" /><path d="M9 9h6M9 13h6M9 17h4" /></>}
  </svg>
);

const iconFor = (moduleId: string): ReactElement => (
  <svg className="module-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {moduleId === "textbefehle" ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v10M8.5 10.5h7M8.5 13.5h5" /></> : moduleId === "kanalereignisse" ? <><path d="M5 12h3l2-5 4 10 2-5h3" /><path d="M5 19h14" /></> : <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 12h6M12 9v6" /></>}
  </svg>
);

export const ModuleIcon = ({ moduleId }: { moduleId: string }): ReactElement => iconFor(moduleId);

export const Led = ({ status, label }: { status: LedStatus; label: string }): ReactElement => (
  <span className="led" data-status={status}>
    <span className="led__dot" aria-hidden="true" />
    <span>{label}</span>
  </span>
);

export const ZustandZeile = ({ label, tone, wort, detail, aktion }: {
  label: string;
  tone: ZustandsTon;
  wort: string;
  detail?: ReactNode;
  aktion?: ReactNode;
}): ReactElement => {
  const status: LedStatus = tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";
  return (
    <article className="zustand-zeile" data-status={tone} aria-label={label}>
      <strong className="zustand-zeile__label">{label}</strong>
      <Led status={status} label={wort} />
      {detail === undefined ? null : <span className="zustand-zeile__detail">{detail}</span>}
      {aktion === undefined ? null : <div className="zustand-zeile__action">{aktion}</div>}
    </article>
  );
};

export const ModuleHeading = ({ kind, title, subtitle, actions }: {
  kind: string;
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
}): ReactElement => (
  <header className="module-detail-heading">
    <div className="module-detail-heading__icon"><NavigationIcon kind={kind} className="module-heading-glyph" /></div>
    <div className="module-detail-heading__copy">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
    {actions === undefined ? null : <div className="module-detail-heading__actions">{actions}</div>}
  </header>
);

export const ModuleCount = ({ count, label }: { count: number; label: (formattedCount: string) => string }): ReactElement => {
  const formattedCount = formatZahl(count);
  return <>{<span className="zahl">{formattedCount}</span>}{label(formattedCount).slice(formattedCount.length)}</>;
};

export const ModuleTaste = ({ channelId, moduleId, enabled, onNavigate, name, icon, route, ledStatus, ledLabel }: {
  channelId: string;
  moduleId: string;
  enabled: boolean;
  onNavigate: (route: DashboardRoute) => void;
  name?: string;
  icon?: ReactElement;
  route?: DashboardRoute;
  ledStatus?: LedStatus;
  ledLabel?: string;
}): ReactElement => {
  const details = moduleDetails(moduleId);
  const tasteRoute: DashboardRoute = route ?? { kind: "module", channelId, moduleId };
  const tasteName = name ?? details.name;
  const tasteStatus = ledStatus ?? (enabled ? "green" : "off");
  const tasteLabel = ledLabel ?? statusWord(enabled);
  const label = `${tasteName} · ${tasteLabel}`;
  return (
    <a
      className="module-taste"
      href={dashboardRoutePath(tasteRoute)}
      aria-label={label}
      data-enabled={enabled ? "true" : "false"}
      data-status={tasteStatus}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(tasteRoute);
      }}
    >
      <span className="module-taste__icon" aria-hidden="true">{icon ?? iconFor(moduleId)}</span>
      <strong>{tasteName}</strong>
      <Led status={tasteStatus} label={tasteLabel} />
    </a>
  );
};

/** Kompatibler Navigationsbaustein für ältere Modul-Tests; die Seiten verwenden das Tastenraster. */
export const ModuleNavigation = ({ channelId, activeModules, onNavigate }: {
  channelId: string;
  activeModules: PanelActiveModule[];
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => (
  <nav className="module-navigation" aria-label={dashboardTexte().module.modul}>
    {activeModules.map(({ moduleId }) => {
      const route: DashboardRoute = { kind: "module", channelId, moduleId };
      return <a className="nav-link" href={dashboardRoutePath(route)} key={moduleId} onClick={(event) => { event.preventDefault(); onNavigate(route); }}>{moduleName(moduleId)}</a>;
    })}
  </nav>
);

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
      className="module-list-link"
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
            <Led status={enabled ? "green" : "off"} label={statusWord(enabled)} />
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
