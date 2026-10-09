import { useEffect, useState, type ReactElement } from "react";

import type { ModulePanelProperties } from "../../contract";
import { WEATHER_ERROR_TEXT_MAX_LENGTH, type WeatherSettings } from "../contracts";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, Field, InspectorFieldRow, InspectorSection, Select, Switch, notify } from "../../../dashboard/ui";
import { weatherModuleCatalog } from "../contracts/catalog";
import { weatherSettingsTexts } from "./locale";
import { fetchWeatherSettings, saveWeatherSettings } from "./service";

export default function WeatherSettingsPanel({ channelId, ...properties }: ModulePanelProperties): ReactElement {
  return <WeatherSettingsPanelContent key={channelId} channelId={channelId} {...properties} />;
}

function WeatherSettingsPanelContent({ channelId, language, canManage }: ModulePanelProperties): ReactElement {
  const locale = language ?? "de";
  const labels = weatherSettingsTexts(locale);
  const catalog = weatherModuleCatalog[locale];
  const canEdit = canManage ?? false;
  const queryClient = useDashboardQueryClient();
  const settingsQuery = useModuleQuery(channelId, "weather", "provider-settings", (signal) => fetchWeatherSettings(channelId, signal));
  const [draft, setDraft] = useState<{ baseRevision: number; value: WeatherSettings; saved: boolean } | null>(null);
  const settings = draft !== null && (!draft.saved || (settingsQuery.data?.revision ?? 0) < draft.value.revision)
    ? draft.value
    : settingsQuery.data ?? null;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (settingsQuery.isError) notify({ tone: "error", message: labels.loadFailed });
  }, [settingsQuery.isError, labels.loadFailed]);

  const updateSettings = (patch: Partial<WeatherSettings>): void => {
    if (settings === null) return;
    const baseRevision = draft !== null && !draft.saved
      ? draft.baseRevision
      : Math.max(settingsQuery.data?.revision ?? 0, settings.revision);
    setDraft({
      baseRevision,
      value: { ...settings, ...patch },
      saved: false,
    });
  };

  const save = async (): Promise<void> => {
    if (settings === null || !canEdit) return;
    setBusy(true);
    try {
      const revision = draft !== null && !draft.saved ? draft.baseRevision : settings.revision;
      const next = await runModuleQueryWrite(queryClient, channelId, "weather", "provider-settings", () =>
        saveWeatherSettings(channelId, { ...settings, revision }), { updateCache: (_current, result) => result });
      setDraft({ baseRevision: next.revision, value: next, saved: true });
      notify({ tone: "success", message: labels.saved });
    } catch (failure: unknown) {
      notify({ tone: "error", message: failure instanceof Error && "code" in failure && failure.code === "weather_settings_conflict"
        ? labels.settingsConflict
        : labels.saveFailed });
    } finally {
      setBusy(false);
    }
  };

  const updateErrors = (languageKey: "de" | "en", value: string): void => {
    if (settings !== null) updateSettings({ errorTexts: { ...settings.errorTexts, [languageKey]: value } });
  };

  return <div className="module-stack weather-settings" aria-label={labels.settings}>
    <InspectorSection title={labels.settings}>
      <InspectorFieldRow label={labels.provider} help={catalog.providers[settings?.provider ?? "met_norway"].description}>
        <Select
          label={labels.provider}
          value={settings?.provider ?? "met_norway"}
          options={[
            { value: "met_norway", label: catalog.providers.met_norway.label, description: catalog.providers.met_norway.description },
            { value: "open_meteo", label: catalog.providers.open_meteo.label, description: catalog.providers.open_meteo.description },
          ]}
          disabled={settings === null || busy || !canEdit}
          onChange={(value) => { if (value === "met_norway" || value === "open_meteo") updateSettings({ provider: value }); }}
        />
      </InspectorFieldRow>
      <Switch
        layout="inline"
        label={labels.fahrenheit}
        hint={labels.fahrenheitHint}
        checked={settings?.showFahrenheit ?? false}
        disabled={settings === null || busy || !canEdit}
        onChange={(showFahrenheit) => updateSettings({ showFahrenheit })}
      />
      <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
        <div className="weather-settings__fields">
          <Field label={labels.unavailableDe} value={settings?.errorTexts.de ?? ""} onChange={(value) => updateErrors("de", value)} maxLength={WEATHER_ERROR_TEXT_MAX_LENGTH} disabled={settings === null || busy || !canEdit} readOnly={!canEdit} countLabel={(count, max) => `${String(count)} / ${String(max)}`} />
          <Field label={labels.unavailableEn} value={settings?.errorTexts.en ?? ""} onChange={(value) => updateErrors("en", value)} maxLength={WEATHER_ERROR_TEXT_MAX_LENGTH} disabled={settings === null || busy || !canEdit} readOnly={!canEdit} countLabel={(count, max) => `${String(count)} / ${String(max)}`} />
        </div>
      </InspectorFieldRow>
      <p className="lock-reason" data-testid="weather-settings-permission-slot" id="weather-settings-read-only" title={canEdit ? undefined : labels.readOnlyReason}
        style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
        {canEdit ? "" : labels.readOnlyReason}
      </p>
      <Button variant="primary" disabled={settings === null || busy || !canEdit} {...(!canEdit ? { describedBy: "weather-settings-read-only" } : {})} onClick={() => { void save(); }}>{labels.save}</Button>
    </InspectorSection>
    <InspectorSection title={labels.sources}>
      <p><a href="https://api.met.no/" target="_blank" rel="noreferrer">{labels.metAttribution}</a></p>
      <p>{labels.metLicense} <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></p>
      <p><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">{labels.openMeteoAttribution}</a></p>
      <p className="muted" data-testid="weather-provider-description-slot" title={settings?.provider === "open_meteo" ? catalog.providers.open_meteo.description : undefined}
        style={{ height: "calc(var(--s6) * 2)", overflow: "hidden", margin: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }} aria-live="polite">
        {settings?.provider === "open_meteo" ? catalog.providers.open_meteo.description : ""}
      </p>
    </InspectorSection>
  </div>;
}
