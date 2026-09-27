import { useEffect, useState, type ReactElement } from "react";

import type { ModuleChannelSettingsProperties } from "../../contract";
import { SUN_ERROR_TEXT_MAX_LENGTH, type SunLocation, type SunSettings } from "../contracts";
import { Button, Field, InspectorFieldRow } from "../../../dashboard/ui";
import { sunLocationTexts } from "./locale";
import { fetchSunSettings, saveSunSettings, searchSunLocations, type SunGeocodingResult } from "./service";

export default function SunLocationSettings({
  channelId,
  language,
  canManage,
  readOnlyReason,
  channelTimeZone,
  saveChannelTimeZone,
}: ModuleChannelSettingsProperties): ReactElement {
  const labels = sunLocationTexts(language);
  const [settings, setSettings] = useState<SunSettings | null>(null);
  const [locationDraft, setLocationDraft] = useState<SunLocation | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly SunGeocodingResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    fetchSunSettings(channelId).then((sunSettings) => {
      if (!active) return;
      setSettings(sunSettings);
      setLocationDraft(sunSettings.location);
      setError("");
    }).catch(() => {
      if (active) setError(labels.loadFailed);
    });
    return () => { active = false; };
  }, [channelId, labels.loadFailed]);

  const search = async (): Promise<void> => {
    if (query.trim().length < 2) return;
    setSearching(true);
    setError("");
    setNotice("");
    try {
      setResults(await searchSunLocations(channelId, query.trim(), language));
    } catch {
      setError(labels.searchFailed);
    } finally {
      setSearching(false);
    }
  };

  const save = async (): Promise<void> => {
    if (settings === null || !canManage) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await saveSunSettings(channelId, {
        revision: settings.revision,
        location: locationDraft,
        errorTexts: settings.errorTexts,
      });
      setSettings(next);
      setLocationDraft(next.location);
      setNotice(labels.saved);
    } catch (saveFailure: unknown) {
      setError(saveFailure instanceof Error && "code" in saveFailure && saveFailure.code === "sun_settings_conflict"
        ? labels.settingsConflict
        : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const applyLocationTimeZone = async (): Promise<void> => {
    if (locationDraft === null || !canManage) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await saveChannelTimeZone(locationDraft.timeZone);
      setNotice(labels.timezoneSaved);
    } catch {
      setError(labels.timezoneSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-stack sun-location-settings" aria-label={labels.location}>
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
      {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
      {!canManage ? <>
        <p className="lock-reason">{readOnlyReason || labels.readOnlyReason}</p>
        <dl className="properties sun-location-settings__properties">
          <div><dt>{labels.location}</dt><dd>{locationDraft === null
            ? "—"
            : <><strong>{locationDraft.name}</strong><br />{locationDraft.latitude.toFixed(4)}, {locationDraft.longitude.toFixed(4)} · {locationDraft.timeZone}</>}</dd></div>
          <div><dt>{labels.unavailableDe}</dt><dd>{settings?.errorTexts.de ?? "—"}</dd></div>
          <div><dt>{labels.unavailableEn}</dt><dd>{settings?.errorTexts.en ?? "—"}</dd></div>
        </dl>
      </> : <>
        <InspectorFieldRow label={labels.location} help={labels.locationHint} className="inspector-field-row--align-start">
        <div className="sun-location-settings__controls">
          <div className="sun-location-settings__search">
            <Field label={labels.search} value={query} onChange={setQuery} disabled={searching} onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }} />
            <Button variant="secondary" disabled={searching || query.trim().length < 2} onClick={() => { void search(); }}>
              {searching ? labels.searching : labels.searchButton}
            </Button>
          </div>
          {results.length === 0 && !searching && query.trim().length >= 2 ? <p className="muted">{labels.noResults}</p> : null}
          <div className="sun-location-settings__results" role="listbox" aria-label={labels.selectLocation}>
            {results.map((result) => {
              const isSelected = locationDraft?.latitude === result.latitude && locationDraft.longitude === result.longitude;
              const description = [result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", ");
              return <div className="sun-location-settings__result" key={`${String(result.latitude)}:${String(result.longitude)}`} role="option" aria-selected={isSelected}>
                <span><strong>{result.name}</strong>{description.length === 0 ? null : <span className="muted"> · {description}</span>}</span>
                <Button size="compact" variant={isSelected ? "primary" : "subtle"} disabled={busy} onClick={() => {
                  const location = { name: [result.name, result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", "), latitude: result.latitude, longitude: result.longitude, timeZone: result.timeZone };
                  setLocationDraft(location);
                  setNotice("");
                }}>{isSelected ? labels.selected : labels.selectLocation}</Button>
              </div>;
            })}
          </div>
          {locationDraft === null ? <p className="muted">—</p> : <p className="sun-location-settings__current"><strong>{locationDraft.name}</strong><span className="muted">{locationDraft.latitude.toFixed(4)}, {locationDraft.longitude.toFixed(4)}</span></p>}
          <div className="sun-location-settings__actions">
            {locationDraft === null ? null : <Button variant="secondary" danger="subtle" disabled={busy} onClick={() => setLocationDraft(null)}>{labels.removeLocation}</Button>}
            {locationDraft === null || locationDraft.timeZone === channelTimeZone ? null : <div className="sun-location-settings__suggestion">
              <span>{labels.timezoneSuggestion}: <code>{locationDraft.timeZone}</code></span>
              <Button size="compact" variant="subtle" disabled={busy} onClick={() => { void applyLocationTimeZone(); }}>{labels.useSuggestedTimeZone}</Button>
            </div>}
          </div>
        </div>
        </InspectorFieldRow>
        <InspectorFieldRow label={labels.errorTexts} help={labels.errorTextsHint}>
        <div className="sun-location-settings__errors">
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
        <div className="sun-location-settings__footer">
          <Button variant="primary" disabled={settings === null || busy} onClick={() => { void save(); }}>{labels.save}</Button>
        </div>
      </>}
    </div>
  );
}
