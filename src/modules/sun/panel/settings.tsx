import { useEffect, useState, type ReactElement } from "react";

import type { ModuleChannelSettingsProperties } from "../../contract";
import { SUN_ERROR_TEXT_MAX_LENGTH, type SunSettings } from "../contracts";
import { Button, Field, InspectorFieldRow } from "../../../dashboard/ui";
import { sunSettingsTexts } from "./locale";
import { fetchSunSettings, saveSunSettings } from "./service";

export default function SunSettingsPanel({
  channelId,
  language,
  canManage,
  readOnlyReason,
}: ModuleChannelSettingsProperties): ReactElement {
  const labels = sunSettingsTexts(language);
  const [settings, setSettings] = useState<SunSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    fetchSunSettings(channelId).then((sunSettings) => {
      if (!active) return;
      setSettings(sunSettings);
      setError("");
    }).catch(() => {
      if (active) setError(labels.loadFailed);
    });
    return () => { active = false; };
  }, [channelId, labels.loadFailed]);

  const save = async (): Promise<void> => {
    if (settings === null || !canManage) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await saveSunSettings(channelId, {
        revision: settings.revision,
        errorTexts: settings.errorTexts,
      });
      setSettings(next);
      setNotice(labels.saved);
    } catch (saveFailure: unknown) {
      setError(saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "sun_settings_conflict"
        ? labels.settingsConflict
        : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-stack sun-settings" aria-label={labels.errorTexts}>
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
      {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
      {!canManage ? <p className="lock-reason">{readOnlyReason || labels.readOnlyReason}</p> : null}
      {!canManage ? <dl className="properties">
        <div><dt>{labels.unavailableDe}</dt><dd>{settings?.errorTexts.de ?? "—"}</dd></div>
        <div><dt>{labels.unavailableEn}</dt><dd>{settings?.errorTexts.en ?? "—"}</dd></div>
      </dl> : <>
        <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
          <div className="sun-settings__fields">
          <Field
            label={labels.unavailableDe}
            value={settings?.errorTexts.de ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, de: value } })}
            maxLength={SUN_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canManage}
            disabled={settings === null || busy}
          />
          <Field
            label={labels.unavailableEn}
            value={settings?.errorTexts.en ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, en: value } })}
            maxLength={SUN_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canManage}
            disabled={settings === null || busy}
          />
          </div>
        </InspectorFieldRow>
        <div className="sun-settings__footer">
        <Button variant="primary" disabled={settings === null || busy} onClick={() => { void save(); }}>{labels.save}</Button>
        </div>
      </>}
    </div>
  );
}
