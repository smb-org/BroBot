import { useEffect, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { MOON_ERROR_TEXT_MAX_LENGTH, type MoonSettings } from "../contracts";
import { Button, Field, InspectorFieldRow } from "../../../dashboard/ui";
import { moonSettingsTexts } from "./locale";
import { fetchMoonSettings, saveMoonSettings } from "./service";

export default function MoonSettingsPanel({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const labels = moonSettingsTexts(language ?? "de");
  const canEdit = canManage ?? false;
  const [settings, setSettings] = useState<MoonSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    fetchMoonSettings(channelId).then((moonSettings) => {
      if (!active) return;
      setSettings(moonSettings);
      setError("");
    }).catch(() => {
      if (active) setError(labels.loadFailed);
    });
    return () => { active = false; };
  }, [channelId, labels.loadFailed]);

  const save = async (): Promise<void> => {
    if (settings === null || !canEdit) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await saveMoonSettings(channelId, { revision: settings.revision, errorTexts: settings.errorTexts });
      setSettings(next);
      setNotice(labels.saved);
    } catch (saveFailure: unknown) {
      setError(saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "moon_settings_conflict"
        ? labels.settingsConflict
        : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-stack moon-settings" aria-label={labels.errorTexts}>
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
      {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
      {!canEdit ? <p className="lock-reason" id="moon-settings-read-only">{labels.readOnlyReason}</p> : null}
      <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
        <div className="moon-settings__fields">
          <Field
            label={labels.unavailableDe}
            value={settings?.errorTexts.de ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, de: value } })}
            maxLength={MOON_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
          <Field
            label={labels.unavailableEn}
            value={settings?.errorTexts.en ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, en: value } })}
            maxLength={MOON_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
        </div>
      </InspectorFieldRow>
      <div className="moon-settings__footer">
        <Button
          variant="primary"
          disabled={settings === null || busy || !canEdit}
          {...(!canEdit ? { describedBy: "moon-settings-read-only" } : {})}
          onClick={() => { void save(); }}
        >{labels.save}</Button>
      </div>
    </div>
  );
}
