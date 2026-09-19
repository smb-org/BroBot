import { useState, type ReactElement } from "react";

import type { PanelChannelRole, PanelModuleState } from "../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "./api";
import { dashboardLanguage, type DashboardLanguage, type LocaleCatalog, formatZahl } from "./locale";

interface ModulesTexte {
  verwaltungGesperrt: string;
  titel: string;
  liste: string;
  verfuegbar: string;
  laden: string;
  registriert: string;
  modul: string;
  aktiv: string;
  inaktiv: string;
  aktivieren: string;
  deaktivieren: string;
  sitzungUngueltig: string;
  aenderungFehlgeschlagen: string;
}

const texte: LocaleCatalog<ModulesTexte> = {
  de: {
    verwaltungGesperrt: "Nur Broadcaster und Verwalter dürfen Module ändern.", titel: "Module", liste: "Modulliste",
    verfuegbar: "Verfügbare Module", laden: "Module werden geladen …", registriert: "Für diesen Bot ist noch kein Modul registriert.",
    modul: "Modul", aktiv: "Aktiv", inaktiv: "Inaktiv", aktivieren: "aktivieren", deaktivieren: "deaktivieren",
    sitzungUngueltig: "Deine Sitzung ist nicht mehr gültig.", aenderungFehlgeschlagen: "Die Moduländerung ist fehlgeschlagen.",
  },
  en: {
    verwaltungGesperrt: "Only broadcasters and managers may change modules.", titel: "Modules", liste: "Module list",
    verfuegbar: "Available modules", laden: "Loading modules …", registriert: "No module is registered for this bot yet.",
    modul: "Module", aktiv: "Active", inaktiv: "Inactive", aktivieren: "enable", deaktivieren: "disable",
    sitzungUngueltig: "Your session is no longer valid.", aenderungFehlgeschlagen: "The module change failed.",
  },
};

const modulesTexte = (language: DashboardLanguage = dashboardLanguage()): ModulesTexte => texte[language];

interface ModulesPageProperties {
  channelId: string;
  ownRole: PanelChannelRole;
  modules: PanelModuleState[];
  loading: boolean;
  error: string | null;
  onReload: () => Promise<void>;
  onAuthenticationRequired: () => void;
}

const errorMessage = (error: unknown): string => {
  if (error instanceof PanelApiError && error.status === 401) return modulesTexte().sitzungUngueltig;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return modulesTexte().aenderungFehlgeschlagen;
};

const canManageModules = (role: PanelChannelRole): boolean => role !== "bediener";

export const ModulesPage = ({
  channelId,
  ownRole,
  modules,
  loading,
  error,
  onReload,
  onAuthenticationRequired,
}: ModulesPageProperties): ReactElement => {
  const texte = modulesTexte();
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
      <header className="page-heading">
        <h1>{texte.titel}</h1>
        <span className="muted zahl">{formatZahl(modules.length)}</span>
      </header>
      <section className="content-section" aria-label={texte.liste}>
        <div className="section-heading"><h2>{texte.verfuegbar}</h2></div>
        {loading ? <p className="loading-line">{texte.laden}</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : modules.length === 0 ? (
          <p className="muted">{texte.registriert}</p>
        ) : (
          <div className="member-table-wrap">
            <table className="member-table">
              <thead><tr><th scope="col">{texte.modul}</th><th scope="col">{texte.aktiv}</th></tr></thead>
              <tbody>
                {modules.map((module) => (
                  <tr key={module.id}>
                    <th scope="row"><span className="mono">{module.id}</span></th>
                    <td>
                      <label className="module-toggle">
                        <input
                          type="checkbox"
                          aria-label={`${module.id} ${module.enabled ? texte.deaktivieren : texte.aktivieren}`}
                          checked={module.enabled}
                          disabled={!manageable || busyModuleId === module.id}
                          title={!manageable ? texte.verwaltungGesperrt : undefined}
                          onChange={() => { void handleToggle(module); }}
                        />
                        {module.enabled ? texte.aktiv : texte.inaktiv}
                      </label>
                      {!manageable ? <span className="sperrgrund">{texte.verwaltungGesperrt}</span> : null}
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
