import { useEffect, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { SUN_ERROR_TEXT_MAX_LENGTH, type SunSettings } from "../contracts";
import { Button, Field, InspectorFieldRow, notify } from "../../../dashboard/ui";
import { sunSettingsTexts } from "./locale";
import { fetchSunSettings, saveSunSettings } from "./service";

export default function SunSettingsPanel({
  channelId,
  language,
  canManage,
}: ModulePanelProperties): ReactElement {
  const labels = sunSettingsTexts(language ?? "de");
  const canEdit = canManage ?? false;
  const [settings, setSettings] = useState<SunSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetchSunSettings(channelId).then((sunSettings) => {
      if (!active) return;
      setSettings(sunSettings);
    }).catch(() => {
      if (active) notify({ tone: "error", message: labels.loadFailed });
    });
    return () => { active = false; };
  }, [channelId, labels.loadFailed]);

  const save = async (): Promise<void> => {
    if (settings === null || !canEdit) return;
    setBusy(true);
    try {
      const next = await saveSunSettings(channelId, {
        revision: settings.revision,
        errorTexts: settings.errorTexts,
      });
      setSettings(next);
      notify({ tone: "success", message: labels.saved });
    } catch (saveFailure: unknown) {
      notify({ tone: "error", message: saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "sun_settings_conflict"
        ? labels.settingsConflict : labels.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-stack sun-settings" aria-label={labels.errorTexts}>
      <>
        <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
          <div className="sun-settings__fields">
          <Field
            label={labels.unavailableDe}
            value={settings?.errorTexts.de ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, de: value } })}
            maxLength={SUN_ERROR_TEXT_MAX_LENGTH}
            countLabel={(count, max) => `${String(count)} / ${String(max)}`}
            readOnly={!canEdit}
            disabled={settings === null || busy || !canEdit}
          />
          <Field
            label={labels.unavailableEn}
            value={settings?.errorTexts.en ?? ""}
            onChange={(value) => setSettings((current) => current === null ? current : { ...current, errorTexts: { ...current.errorTexts, en: value } })}
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
  );
}
