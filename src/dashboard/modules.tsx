import { useState, type ReactElement } from "react";

import type { ChannelRole } from "../contracts/values";
import type { PanelModuleState } from "../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "./api";
import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog, formatNumber } from "./locale";
import { moduleDescription, moduleName } from "./module-labels";
import { ModuleHeading, ModuleIcon, StateRow } from "./module-panels";
import { dashboardRoutePath, type DashboardRoute } from "./router";
import { Switch } from "./ui";


interface ModulesTexts {
  managementLocked: string;
  title: string;
  list: string;
  available: string;
  load: string;
  registered: string;
  active: string;
  inactive: string;
  noDescription: string;
  openModule: (name: string) => string;
  sessionInvalid: string;
  changeFailed: string;
}

const texts: LocaleCatalog<ModulesTexts> = {
  de: {
    managementLocked: "Nur Broadcaster und Verwalter dürfen Module ändern.", title: "Module", list: "Modulliste",
    available: "Verfügbare Module", load: "Module werden geladen …", registered: "Für diesen Bot ist noch kein Modul registriert.",
    active: "Aktiv", inactive: "Inaktiv", noDescription: "Keine Beschreibung für dieses Modul.",
    openModule: (name) => `${name} öffnen`,
    sessionInvalid: "Deine Sitzung ist nicht mehr gültig.", changeFailed: "Die Moduländerung ist fehlgeschlagen.",
  },
  en: {
    managementLocked: "Only broadcasters and managers may change modules.", title: "Modules", list: "Module list",
    available: "Available modules", load: "Loading modules …", registered: "No module is registered for this bot yet.",
    active: "Active", inactive: "Inactive", noDescription: "No description is available for this module.",
    openModule: (name) => `Open ${name}`,
    sessionInvalid: "Your session is no longer valid.", changeFailed: "The module change failed.",
  },
};

const modulesTexts = (language: DashboardLanguage = dashboardLanguage()): ModulesTexts => texts[language];

interface ModulesPageProperties {
  channelId: string;
  ownRole: ChannelRole;
  modules: PanelModuleState[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onAuthenticationRequired: () => void;
  onNavigate: (route: DashboardRoute) => void;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return modulesTexts().sessionInvalid;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return modulesTexts().changeFailed;
};

const canManageModules = (role: ChannelRole): boolean => role !== "operator";

// Legacy-only file: see the eslint-disable on `ModulesPage` below.
// eslint-disable-next-line react-refresh/only-export-components
const ModuleRow = ({
  channelId,
  module,
  manageable,
  busy,
  onToggle,
  onNavigate,
}: {
  channelId: string;
  module: PanelModuleState;
  manageable: boolean;
  busy: boolean;
  onToggle: () => Promise<void>;
  onNavigate: (route: DashboardRoute) => void;
}): ReactElement => {
  const labels = modulesTexts();
  const name = moduleName(module.id);
  const description = moduleDescription(module.id) ?? labels.noDescription;
  const state = module.enabled ? labels.active : labels.inactive;
  const route: DashboardRoute = { kind: "module", channelId, moduleId: module.id };

  return (
    <StateRow
      label={name}
      tone={module.enabled ? "healthy" : "neutral"}
      word={state}
      icon={<ModuleIcon moduleId={module.id} className="scope-zeile__icon" />}
      detail={description}
      action={
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <Switch
            checked={module.enabled}
            ariaLabel={`${name}: ${state}`}
            onChange={() => { void onToggle(); }}
            pending={busy}
            {...(manageable ? {} : { lockedReason: labels.managementLocked })}
          />
          <a
            className="module-list-link"
            href={dashboardRoutePath(route)}
            aria-label={labels.openModule(name)}
            onClick={(event) => { event.preventDefault(); onNavigate(route); }}
          >{labels.openModule(name)}</a>
        </div>
      }
    />
  );
};

// Legacy-only file: the component intentionally is no longer exported.
// eslint-disable-next-line react-refresh/only-export-components
const ModulesPage = ({
  channelId,
  ownRole,
  modules,
  loading,
  error,
  onReload,
  onAuthenticationRequired,
  onNavigate,
}: ModulesPageProperties): ReactElement => {
  const labels = modulesTexts();
  const [busyModuleId, setBusyModuleId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const manageable = canManageModules(ownRole);

  const handleToggle = async (module: PanelModuleState): Promise<void> => {
    setBusyModuleId(module.id);
    setActionError(null);
    try {
      await setChannelModuleEnabled(channelId, module.id, !module.enabled);
      await onReload();
    } catch (toggleError: unknown) {
      setActionError(errorMessage(toggleError));
      if (toggleError instanceof PanelApiError && toggleError.status === 401) onAuthenticationRequired();
    } finally {
      setBusyModuleId(null);
    }
  };

  return (
    <>
      <ModuleHeading kind="modules" title={labels.title} subtitle={formatNumber(modules.length)} />
      <section className="content-section" aria-label={labels.list}>
        <div className="section-heading"><h2>{labels.available}</h2></div>
        {loading ? <p className="loading-line">{labels.load}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : modules.length === 0 ? (
          <p className="muted">{labels.registered}</p>
        ) : (
          <div className="zustand-liste">
            {modules.map((module) => (
              <ModuleRow
                key={module.id}
                channelId={channelId}
                module={module}
                manageable={manageable}
                busy={busyModuleId === module.id}
                onToggle={() => handleToggle(module)}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
};

// This legacy view is no longer part of dashboard routing. The file
// stays as a transition; its unreferenced export has been removed.
void ModulesPage;
