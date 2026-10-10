import { useEffect, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { SUN_ERROR_TEXT_MAX_LENGTH, type SunSettings } from "../contracts";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, Field, InspectorFieldRow, LoadState, notify, Skeleton } from "../../../dashboard/ui";
import { sunSettingsTexts } from "./locale";
import { fetchSunSettings, saveSunSettings } from "./service";

export default function SunSettingsPanel({
  channelId,
  ...properties
}: ModulePanelProperties): ReactElement {
  return <SunSettingsPanelContent key={channelId} channelId={channelId} {...properties} />;
}

function SunSettingsPanelContent({
  channelId,
  language,
  canManage,
}: ModulePanelProperties): ReactElement {
  const labels = sunSettingsTexts(language ?? "de");
  const canEdit = canManage ?? false;
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(channelId, "sun", "error-texts", (signal) => fetchSunSettings(channelId, signal));
  const [draft, setDraft] = useState<{ baseRevision: number; value: SunSettings } | null>(null);
  const settings = draft?.value ?? settingsQuery.data ?? null;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settingsQuery.isError) notify({ tone: "error", message: labels.loadFailed });
  }, [settingsQuery.isError, labels.loadFailed]);

  const updateErrors = (languageKey: "de" | "en", value: string): void => {
    if (settings === null) return;
    const baseRevision = draft?.baseRevision ?? settings.revision;
    setDraft({
      baseRevision,
      value: { ...settings, errorTexts: { ...settings.errorTexts, [languageKey]: value } },
    });
  };

  const save = async (): Promise<void> => {
    if (settings === null || !canEdit) return;
    setBusy(true);
    try {
      const baselineRevision = draft?.baseRevision ?? settings.revision;
      await runModuleQueryWrite(queryClient, channelId, "sun", "error-texts", (revision) => {
        if (revision === null) throw new Error("A sun settings revision is required.");
        return saveSunSettings(channelId, {
          revision,
          errorTexts: settings.errorTexts,
        });
      }, { baselineRevision, updateCache: (_current, result) => result });
      setDraft(null);
      notify({ tone: "success", message: labels.saved });
    } catch (saveFailure: unknown) {
      notify({ tone: "error", message: saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "sun_settings_conflict"
        ? labels.settingsConflict : labels.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoadState
      variant="panel-480"
      status={settings === null ? settingsQuery.isError ? "error" : "loading" : "success"}
      loading={<Skeleton rows={3} height={34} />}
      empty={<div />}
      error={<p>{labels.loadFailed}</p>}
      queryError={{ message: labels.loadFailed, onRetry: () => { void settingsQuery.refetch(); } }}
      refreshError={settingsQuery.isRefetchError}
    >
    <div className="module-stack sun-settings" aria-label={labels.errorTexts}>
      <>
        <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
          <div className="sun-settings__fields">
          <Field
            label={labels.unavailableDe}
            value={settings?.errorTexts.de ?? ""}
            onChange={(value) => updateErrors("de", value)}
            maxLength={SUN_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
          <Field
            label={labels.unavailableEn}
            value={settings?.errorTexts.en ?? ""}
            onChange={(value) => updateErrors("en", value)}
            maxLength={SUN_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
          </div>
        </InspectorFieldRow>
        <p className="lock-reason" id="sun-settings-read-only" data-testid="sun-settings-permission-slot"
          title={canEdit ? undefined : labels.readOnlyReason}
          style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
          {!canEdit ? labels.readOnlyReason : ""}
        </p>
        <div className="sun-settings__footer">
        <Button
          variant="primary"
          disabled={settings === null || busy || !canEdit}
          {...(!canEdit ? { describedBy: "sun-settings-read-only" } : {})}
          onClick={() => { void save(); }}
        >{labels.save}</Button>
        </div>
      </>
    </div>
    </LoadState>
  );
}
