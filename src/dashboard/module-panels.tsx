import { lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactElement, type ReactNode } from "react";

import { MODULES } from "../modules/registry";
import type { ModulePanelProperties } from "../modules/contract";
import { canManage, type ChannelRole } from "../contracts/values";
import type { PanelActiveModule, PanelModuleState } from "../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "./api";
import { apiErrorText, dashboardLanguage, dashboardTexts, formatNumber, type DashboardLanguage, type LocaleCatalog } from "./locale";
import { moduleDescription, moduleName, moduleScopePurpose, moduleSymbol, statusWord } from "./module-labels";
import { dashboardRoutePath, type DashboardRoute } from "./router";
import { Switch } from "./ui";

const lazyPanels = new Map<string, LazyExoticComponent<ComponentType<ModulePanelProperties>>>();

interface ModuleWorkspaceTexts {
  status: string;
  mainSwitch: string;
  content: string;
  unknown: (name: string) => string;
  notActive: (name: string) => string;
  switchedOff: (name: string) => string;
  disabled: string;
  noDescription: string;
}

const workspaceCatalog: LocaleCatalog<ModuleWorkspaceTexts> = {
  de: {
    status: "Modulstatus",
    mainSwitch: "Hauptschalter",
    content: "Modulinhalt",
    unknown: (name) => `Das Modul „${name}“ ist nicht bekannt.`,
    notActive: (name) => `Das Modul „${name}“ ist in diesem Kanal nicht aktiv.`,
    switchedOff: (name) => `Das Modul „${name}“ ist ausgeschaltet.`,
    disabled: "Deaktiviert",
    noDescription: "Keine Beschreibung für dieses Modul.",
  },
  en: {
    status: "Module status",
    mainSwitch: "Main switch",
    content: "Module content",
    unknown: (name) => `The module “${name}” is unknown.`,
    notActive: (name) => `The module “${name}” is not active in this channel.`,
    switchedOff: (name) => `The module “${name}” is switched off.`,
    disabled: "Disabled",
    noDescription: "No description is available for this module.",
  },
};

const workspaceTexts = (language: DashboardLanguage = dashboardLanguage()): ModuleWorkspaceTexts => workspaceCatalog[language];

const moduleDetails = (moduleId: string, language: DashboardLanguage = dashboardLanguage()): { name: string; description: string } => ({
  name: moduleName(moduleId, language),
  description: moduleDescription(moduleId, language) ?? workspaceTexts(language).noDescription,
});

export type StateTone = "healthy" | "warning" | "error" | "neutral";
export type LedStatus = "green" | "amber" | "red" | "off";

export const NavigationIcon = ({ kind, className = "navigation-icon" }: { kind: string; className?: string }): ReactElement => (
  <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {kind === "overview" ? <><rect x="5" y="5" width="5" height="5" rx="1" /><rect x="14" y="5" width="5" height="5" rx="1" /><rect x="5" y="14" width="5" height="5" rx="1" /><rect x="14" y="14" width="5" height="5" rx="1" /></> : kind === "channel" ? <><path d="M5 7.5h14M5 12h14M5 16.5h9" /><circle cx="18" cy="16.5" r="1" /></> : kind === "system" ? <><circle cx="12" cy="12" r="7" /><path d="M12 8v4l2.5 2" /></> : kind === "members" ? <><circle cx="10" cy="9" r="3" /><path d="M4.5 18c.8-3 2.6-4.5 5.5-4.5s4.7 1.5 5.5 4.5M17 8.5a2.5 2.5 0 0 1 0 5" /></> : kind === "modules" ? <><rect x="5" y="5" width="6" height="6" rx="1" /><rect x="13" y="5" width="6" height="6" rx="1" /><rect x="5" y="13" width="6" height="6" rx="1" /><rect x="13" y="13" width="6" height="6" rx="1" /></> : kind === "permission" ? <><circle cx="8.5" cy="15.5" r="3.5" /><path d="m11 13 7-7 2 2-7 7M16 8l2 2" /></> : <><path d="M6 5h12v14H6z" /><path d="M9 9h6M9 13h6M9 17h4" /></>}
  </svg>
);

const iconFor = (moduleId: string, className = "module-glyph"): ReactElement => {
  const symbol = moduleSymbol(moduleId);
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {symbol === "text_commands" ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v10M8.5 10.5h7M8.5 13.5h5" /></> : symbol === "channel_events" ? <><path d="M5 12h3l2-5 4 10 2-5h3" /><path d="M5 19h14" /></> : symbol === "ads" ? <><path d="M6 8h12v8H6z" /><path d="M9 8V6h6v2M9 12h6M9 16v2h6v-2" /></> : <><rect x="5" y="5" width="14" height="14" rx="2" /><path d="M9 12h6M12 9v6" /></>}
    </svg>
  );
};

export const ModuleIcon = ({ moduleId, className }: { moduleId: string; className?: string }): ReactElement => iconFor(moduleId, className);

export const Led = ({ status, label }: { status: LedStatus; label: string }): ReactElement => (
  <span className="led" data-status={status}>
    <span className="led__dot" aria-hidden="true" />
    <span>{label}</span>
  </span>
);

export const StateRow = ({ label, tone, word, detail, action, icon }: {
  label: string;
  tone: StateTone;
  word: string;
  detail?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}): ReactElement => {
  const status: LedStatus = tone === "healthy" ? "green" : tone === "warning" ? "amber" : tone === "error" ? "red" : "off";
  return (
    <article className="zustand-zeile" data-status={tone} aria-label={label}>
      <strong className="zustand-zeile__label">{icon}{label}</strong>
      <Led status={status} label={word} />
      {detail === undefined ? null : <span className="zustand-zeile__detail">{detail}</span>}
      {action === undefined ? null : <div className="zustand-zeile__action">{action}</div>}
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
  const formattedCount = formatNumber(count);
  return <>{<span className="zahl">{formattedCount}</span>}{label(formattedCount).slice(formattedCount.length)}</>;
};

export const ModuleTile = ({ channelId, moduleId, enabled, onNavigate, name, icon, route, ledStatus, ledLabel }: {
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
  const tileRoute: DashboardRoute = route ?? { kind: "module", channelId, moduleId };
  const tileName = name ?? details.name;
  const tileStatus = ledStatus ?? (enabled ? "green" : "off");
  const tileLabel = ledLabel ?? statusWord(enabled);
  const label = `${tileName} · ${tileLabel}`;
  return (
    <a
      className="module-taste"
      href={dashboardRoutePath(tileRoute)}
      aria-label={label}
      data-enabled={enabled ? "true" : "false"}
      data-status={tileStatus}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(tileRoute);
      }}
    >
      <span className="module-taste__icon" aria-hidden="true">{icon ?? iconFor(moduleId)}</span>
      <strong>{tileName}</strong>
      <Led status={tileStatus} label={tileLabel} />
    </a>
  );
};

/** Compatibility navigation component for older module tests; the pages use the tile grid. */
export const ModuleNavigation = ({ channelId, activeModules, onNavigate }: {
  channelId: string;
  activeModules: PanelActiveModule[];
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => (
  <nav className="module-navigation" aria-label={dashboardTexts().module.module}>
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
  canManage?: boolean;
}

export const ModulePanelMount = ({ channelId, activeModules, canManage = true }: ModulePanelMountProperties): ReactElement => {
  const registeredPanels = activeModules.flatMap((activeModule) => {
    const module = MODULES.find((candidate) => candidate.id === activeModule.moduleId);
    if (module === undefined) return [];
    const panel = getLazyPanel(module);
    return panel === null ? [] : [{ id: activeModule.moduleId, Panel: panel }];
  });

  if (registeredPanels.length === 0) {
    const texts = dashboardTexts();
    return (
      <section className="module-empty" aria-label={texts.module.module}>
        <p>{activeModules.length === 0 ? texts.module.noneActive : texts.module.noView}</p>
      </section>
    );
  }

  return (
    <section className="module-stack" aria-label={dashboardTexts().module.views}>
      <Suspense fallback={<p className="muted">{dashboardTexts().module.loadingViews}</p>}>
        {registeredPanels.map(({ id, Panel }) => <Panel key={id} channelId={channelId} language={dashboardLanguage()} canManage={canManage} />)}
      </Suspense>
    </section>
  );
};

const canManageModules = canManage;

interface ModuleWorkspaceProperties {
  channelId: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  loading?: boolean;
  error?: string | null;
  onNavigate: (route: DashboardRoute) => void;
  /** Reloads `modules` after a successful toggle. */
  onChanged: () => Promise<void>;
}

const ModuleWorkspaceRow = ({
  channelId,
  moduleId,
  rawEnabled,
  missingScopes,
  manageable,
  busy,
  onToggle,
  onNavigate,
}: {
  channelId: string;
  moduleId: string;
  rawEnabled: boolean;
  missingScopes: string[];
  manageable: boolean;
  busy: boolean;
  onToggle: (nextEnabled: boolean) => void;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const labels = workspaceTexts();
  const texts = dashboardTexts();
  const details = moduleDetails(moduleId);
  const effectiveEnabled = rawEnabled && missingScopes.length === 0;
  const state = missingScopes.length > 0 ? labels.disabled : statusWord(effectiveEnabled);
  const route: DashboardRoute = { kind: "module", channelId, moduleId };

  return (
    <StateRow
      label={details.name}
      tone={missingScopes.length > 0 ? "warning" : effectiveEnabled ? "healthy" : "neutral"}
      word={state}
      icon={<ModuleIcon moduleId={moduleId} className="scope-zeile__icon" />}
      detail={details.description}
      action={
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Switch
            checked={rawEnabled}
            ariaLabel={`${details.name}: ${statusWord(rawEnabled)}`}
            pending={busy}
            onChange={onToggle}
            {...(manageable ? {} : { lockedReason: texts.module.managementLocked })}
          />
          <a
            className="module-list-link"
            href={dashboardRoutePath(route)}
            onClick={(event) => { event.preventDefault(); onNavigate(route); }}
          >{`${details.name} · ${statusWord(effectiveEnabled)}`}</a>
        </div>
      }
    />
  );
};

export const ModuleWorkspace = ({ channelId, ownRole, modules, loading = false, error = null, onNavigate, onChanged }: ModuleWorkspaceProperties): ReactElement => {
  const texts = dashboardTexts();
  const manageable = canManageModules(ownRole);
  // Holds the clicked value only while the request is in flight; afterwards
  // the caller reloads `modules`, so the list, sidebar and overview agree.
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const [busyModuleId, setBusyModuleId] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const toggle = async (moduleId: string, nextEnabled: boolean): Promise<void> => {
    setBusyModuleId(moduleId);
    setToggleError(null);
    setPendingEnabled((current) => ({ ...current, [moduleId]: nextEnabled }));
    try {
      await setChannelModuleEnabled(channelId, moduleId, nextEnabled);
      await onChanged();
    } catch (toggleFailure: unknown) {
      if (toggleFailure instanceof PanelApiError && toggleFailure.status === 401) {
        setToggleError(texts.errors.sessionInvalid);
      } else {
        setToggleError(toggleFailure instanceof PanelApiError
          ? apiErrorText(toggleFailure.code, texts.errors.changeFailed)
          : texts.errors.changeFailed);
      }
    } finally {
      setPendingEnabled((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== moduleId)));
      setBusyModuleId(null);
    }
  };

  return (
    <section className="module-workspace" aria-label={dashboardTexts().navigation.module}>
      <div className="module-workspace__main">
        <header className="module-workspace__heading">
          <h1>{dashboardTexts().navigation.module}</h1>
          {loading ? <span className="muted">{dashboardTexts().module.load}</span> : null}
        </header>
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {toggleError === null ? null : <p className="form-error" role="alert">{toggleError}</p>}
        <div className="zustand-liste">
          {MODULES.map((module) => {
            const state = modules.find((candidate) => candidate.id === module.id);
            const rawEnabled = pendingEnabled[module.id] ?? state?.enabled === true;
            return (
              <ModuleWorkspaceRow
                key={module.id}
                channelId={channelId}
                moduleId={module.id}
                rawEnabled={rawEnabled}
                missingScopes={state?.missingBroadcasterScopes ?? []}
                manageable={manageable}
                busy={busyModuleId === module.id}
                onToggle={(nextEnabled) => { void toggle(module.id, nextEnabled); }}
                onNavigate={onNavigate}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
};

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
      {dashboardTexts().navigation.module}
    </a>
  );
};

interface ModulePageProperties {
  channelId: string;
  moduleId: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  activeModules: PanelActiveModule[];
  loading?: boolean;
  error?: string | null;
  busy?: boolean;
  onNavigate: (route: DashboardRoute) => void;
  onToggle: () => void;
}

export const ModulePage = ({ channelId, moduleId, ownRole, modules, activeModules, loading = false, error = null, busy = false, onNavigate, onToggle }: ModulePageProperties): ReactElement => {
  const texts = dashboardTexts();
  const labels = workspaceTexts();
  const details = moduleDetails(moduleId);
  const registered = MODULES.find((candidate) => candidate.id === moduleId);
  const moduleState = modules.find((candidate) => candidate.id === moduleId);
  const activeModule = activeModules.find((candidate) => candidate.moduleId === moduleId);
  const enabled = moduleState?.enabled === true;
  const manageable = canManageModules(ownRole);
  const disabledReason = manageable ? null : texts.module.managementLocked;
  const switchDisabled = registered === undefined || moduleState === undefined;
  const missingScopes = moduleState?.missingBroadcasterScopes ?? [];
  const requiredScopes = moduleState?.requiredBroadcasterScopes ?? registered?.broadcasterScopes ?? [];
  const missingScopeSet = new Set(missingScopes);
  const effectiveEnabled = enabled && missingScopes.length === 0;
  const viewLoading = loading || moduleState === undefined || (enabled && activeModule === undefined);
  const showActiveView = activeModule !== undefined && (enabled || moduleState === undefined);

  const stateMessage = registered === undefined
    ? labels.unknown(details.name)
    : missingScopes.length > 0
      ? texts.module.scopesMissing(details.name)
      : moduleState?.enabled === false
        ? labels.switchedOff(details.name)
        : null;
  const stateTone = registered === undefined || missingScopes.length > 0 ? "notice" : "neutral";

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
            <strong>{labels.mainSwitch}</strong>
            <Led status={effectiveEnabled ? "green" : "off"} label={statusWord(effectiveEnabled)} />
          </div>
          <ModuleSwitch moduleId={moduleId} enabled={effectiveEnabled} disabled={!manageable || switchDisabled} busy={busy} onToggle={onToggle} />
          {disabledReason === null ? null : <p className="sperrgrund">{disabledReason}</p>}
        </section>
        {missingScopes.length === 0 ? null : <section className="module-detail__authorization" aria-label={texts.module.scopeList}>
          <div className="section-heading"><h2>{texts.module.scopeList}</h2></div>
          <div className="zustand-liste module-scope-list">
            {requiredScopes.map((scope) => {
              const missing = missingScopeSet.has(scope);
              return <StateRow
                key={scope}
                label={moduleScopePurpose(moduleId, scope)}
                tone={missing ? "warning" : "healthy"}
                word={missing ? texts.module.scopeMissing : texts.module.scopeGranted}
                detail={<span className="mono">{scope}</span>}
                icon={<NavigationIcon kind="permission" className="scope-zeile__icon" />}
              />;
            })}
          </div>
          {ownRole === "broadcaster"
            ? <a className="button button--primary" href={`/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/${encodeURIComponent(moduleId)}`}>{texts.module.requestScopeConsent}</a>
            : <button className="button button--primary" type="button" disabled>{texts.module.requestScopeConsent}</button>}
          {ownRole === "broadcaster" ? null : <p className="sperrgrund">{texts.module.scopeConsentLocked}</p>}
        </section>}
        {viewLoading ? <p className="muted">{texts.module.load}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {stateMessage === null ? (
          registered?.panel === undefined ? (showActiveView ? <p className="module-state">{texts.module.noView}</p> : null) : !showActiveView ? null : (
            <section className={`module-detail__content${viewLoading ? " veraltet" : ""}`} aria-label={labels.content}>
              <ModulePanelMount channelId={channelId} activeModules={[activeModule]} canManage={ownRole !== "operator"} />
            </section>
          )
        ) : (
          <section className={`module-state module-state--${stateTone}`} aria-label={texts.module.module}>
            <div className="module-state__summary">
              <NavigationIcon kind="permission" className="module-state__icon" />
              <p>{stateMessage}</p>
            </div>
            <ModuleListLink channelId={channelId} onNavigate={onNavigate} />
          </section>
        )}
      </section>
    </>
  );
};
