import { useEffect, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { MOON_ERROR_TEXT_MAX_LENGTH, type MoonSettings } from "../contracts";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, Field, InspectorFieldRow, LoadState, notify, Skeleton } from "../../../dashboard/ui";
import { moonSettingsTexts } from "./locale";
import { fetchMoonSettings, saveMoonSettings } from "./service";

export default function MoonSettingsPanel({ channelId, ...properties }: ModulePanelProperties): ReactElement {
  return <MoonSettingsPanelContent key={channelId} channelId={channelId} {...properties} />;
}

function MoonSettingsPanelContent({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const labels = moonSettingsTexts(language ?? "de");
  const canEdit = canManage ?? false;
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(channelId, "moon", "unavailable-texts", (signal) => fetchMoonSettings(channelId, signal));
  const [draft, setDraft] = useState<{ baseRevision: number; value: MoonSettings; saved: boolean } | null>(null);
  const settings = draft !== null && (!draft.saved || (settingsQuery.data?.revision ?? 0) < draft.value.revision)
    ? draft.value
    : settingsQuery.data ?? null;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settingsQuery.isError) notify({ tone: "error", message: labels.loadFailed });
  }, [settingsQuery.isError, labels.loadFailed]);

  const updateErrors = (languageKey: "de" | "en", value: string): void => {
    if (settings === null) return;
    const baseRevision = draft !== null && !draft.saved
      ? draft.baseRevision
      : Math.max(settingsQuery.data?.revision ?? 0, settings.revision);
    setDraft({
      baseRevision,
      value: { ...settings, errorTexts: { ...settings.errorTexts, [languageKey]: value } },
      saved: false,
    });
  };

  const save = async (): Promise<void> => {
    if (settings === null || !canEdit) return;
    setBusy(true);
    try {
      const baselineRevision = draft !== null && !draft.saved ? draft.baseRevision : settings.revision;
      const next = await runModuleQueryWrite(queryClient, channelId, "moon", "unavailable-texts", (revision) => {
        if (revision === null) throw new Error("A moon settings revision is required.");
        return saveMoonSettings(channelId, { revision, errorTexts: settings.errorTexts });
      }, {
        baselineRevision,
        updateCache: (_current, result) => result,
      });
      setDraft({ baseRevision: next.revision, value: next, saved: true });
      notify({ tone: "success", message: labels.saved });
    } catch (saveFailure: unknown) {
      notify({ tone: "error", message: saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "moon_settings_conflict"
        ? labels.settingsConflict : labels.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <LoadState
      status={settings === null ? settingsQuery.isError ? "error" : "loading" : "success"}
      minHeight="calc(var(--s10) * 12)"
      loading={<Skeleton rows={3} height={34} />}
      empty={<div />}
      error={<p>{labels.loadFailed}</p>}
      onRetry={() => { void settingsQuery.refetch(); }}
      refreshError={settingsQuery.isRefetchError}
    >
    <div className="module-stack moon-settings" aria-label={labels.errorTexts}>
      <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
        <div className="moon-settings__fields">
          <Field
            label={labels.unavailableDe}
            value={settings?.errorTexts.de ?? ""}
            onChange={(value) => updateErrors("de", value)}
            maxLength={MOON_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
          <Field
            label={labels.unavailableEn}
            value={settings?.errorTexts.en ?? ""}
            onChange={(value) => updateErrors("en", value)}
            maxLength={MOON_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
        </div>
      </InspectorFieldRow>
      <p className="lock-reason" id="moon-settings-read-only" data-testid="moon-settings-permission-slot"
        title={canEdit ? undefined : labels.readOnlyReason}
        style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
        {!canEdit ? labels.readOnlyReason : ""}
      </p>
      <div className="moon-settings__footer">
        <Button
          variant="primary"
          disabled={settings === null || busy || !canEdit}
          {...(!canEdit ? { describedBy: "moon-settings-read-only" } : {})}
          onClick={() => { void save(); }}
        >{labels.save}</Button>
      </div>
    </div>
    </LoadState>
  );
}
