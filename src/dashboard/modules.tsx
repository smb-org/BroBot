import { useState, type ReactElement } from "react";

import type { ChannelRole } from "../contracts/values";
import type { PanelModuleState } from "../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "./api";
import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog, formatNumber } from "./locale";
import { ModuleHeading } from "./module-panels";


interface ModulesTexts {
  managementLocked: string;
  title: string;
  list: string;
  available: string;
  load: string;
  registered: string;
  module: string;
  active: string;
  inactive: string;
  enable: string;
  disable: string;
  sessionInvalid: string;
  changeFailed: string;
}

const texts: LocaleCatalog<ModulesTexts> = {
  de: {
    managementLocked: "Nur Broadcaster und Verwalter dürfen Module ändern.", title: "Module", list: "Modulliste",
    available: "Verfügbare Module", load: "Module werden geladen …", registered: "Für diesen Bot ist noch kein Modul registriert.",
    module: "Modul", active: "Aktiv", inactive: "Inaktiv", enable: "aktivieren", disable: "deaktivieren",
    sessionInvalid: "Deine Sitzung ist nicht mehr gültig.", changeFailed: "Die Moduländerung ist fehlgeschlagen.",
  },
  en: {
    managementLocked: "Only broadcasters and managers may change modules.", title: "Modules", list: "Module list",
    available: "Available modules", load: "Loading modules …", registered: "No module is registered for this bot yet.",
    module: "Module", active: "Active", inactive: "Inactive", enable: "enable", disable: "disable",
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
}

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return modulesTexts().sessionInvalid;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return modulesTexts().changeFailed;
};

const canManageModules = (role: ChannelRole): boolean => role !== "operator";

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
}: ModulesPageProperties): ReactElement => {
  const texts = modulesTexts();
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
      <ModuleHeading kind="modules" title={texts.title} subtitle={formatNumber(modules.length)} />
      <section className="content-section" aria-label={texts.list}>
        <div className="section-heading"><h2>{texts.available}</h2></div>
        {loading ? <p className="loading-line">{texts.load}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : modules.length === 0 ? (
          <p className="muted">{texts.registered}</p>
        ) : (
          <div className="tabelle-wrap">
            <table className="tabelle">
              <thead><tr><th scope="col">{texts.module}</th><th scope="col">{texts.active}</th></tr></thead>
              <tbody>
                {modules.map((module) => (
                  <tr key={module.id}>
                    <th scope="row"><span className="mono">{module.id}</span></th>
                    <td>
                      <label className="module-toggle">
                        <input
                          type="checkbox"
                          aria-label={`${module.id} ${module.enabled ? texts.disable : texts.enable}`}
                          checked={module.enabled}
                          disabled={!manageable || busyModuleId === module.id}
                          title={!manageable ? texts.managementLocked : undefined}
                          onChange={() => { void handleToggle(module); }}
                        />
                        {module.enabled ? texts.active : texts.inactive}
                      </label>
                      {!manageable ? <span className="sperrgrund">{texts.managementLocked}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
};

// This legacy view is no longer part of dashboard routing. The file
// stays as a transition; its unreferenced export has been removed.
void ModulesPage;
