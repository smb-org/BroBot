import { useState, type ReactElement } from "react";

import type { PanelChannelRole, PanelModuleState } from "../panel-contract";
import { PanelApiError, setChannelModuleEnabled } from "./api";

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
  if (error instanceof PanelApiError && error.status === 401) return "Deine Sitzung ist nicht mehr gültig.";
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Die Moduländerung ist fehlgeschlagen.";
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
        <h1>Module</h1>
        <span className="muted zahl">{String(modules.length)}</span>
      </header>
      <section className="content-section" aria-label="Modulliste">
        <div className="section-heading"><h2>Verfügbare Module</h2></div>
        {loading ? <p className="loading-line">Module werden geladen …</p> : null}
        {error === null ? null : <p className="form-error" role="alert">{error}</p>}
        {actionError === null ? null : <p className="form-error" role="alert">{actionError}</p>}
        {loading || error !== null ? null : modules.length === 0 ? (
          <p className="muted">Für diesen Bot ist noch kein Modul registriert.</p>
        ) : (
          <div className="member-table-wrap">
            <table className="member-table">
              <thead><tr><th scope="col">Modul</th><th scope="col">Aktiv</th></tr></thead>
              <tbody>
                {modules.map((module) => (
                  <tr key={module.id}>
                    <th scope="row"><span className="mono">{module.id}</span></th>
                    <td>
                      <label className="module-toggle">
                        <input
                          type="checkbox"
                          aria-label={`${module.id} ${module.enabled ? "deaktivieren" : "aktivieren"}`}
                          checked={module.enabled}
                          disabled={!manageable || busyModuleId === module.id}
                          onChange={() => { void handleToggle(module); }}
                        />
                        {module.enabled ? "Aktiv" : "Inaktiv"}
                      </label>
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
