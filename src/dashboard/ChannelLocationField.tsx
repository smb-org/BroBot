import { useState, type ReactElement } from "react";

import {
  saveChannelLocation,
  searchChannelLocations,
  type PanelChannelLocation,
  type PanelChannelLocationResult,
} from "./api";
import { channelSettingsTexts } from "./channel-settings-locale";
import { Button, Field } from "./ui";

interface ChannelLocationFieldProperties {
  channelId: string;
  language: "de" | "en";
  value: PanelChannelLocation | null;
  revision: number;
  onSaved: (location: PanelChannelLocation | null, revision: number) => void;
  channelTimeZone: string;
  onSaveChannelTimeZone: (timeZone: string) => Promise<void>;
  canEdit: boolean;
  disabled: boolean;
}

export const ChannelLocationField = ({
  channelId,
  language,
  value,
  revision,
  onSaved,
  channelTimeZone,
  onSaveChannelTimeZone,
  canEdit,
  disabled,
}: ChannelLocationFieldProperties): ReactElement => {
  const labels = channelSettingsTexts(language);
  const [draft, setDraft] = useState<PanelChannelLocation | null>(value);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PanelChannelLocationResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const search = async (): Promise<void> => {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) return;
    setSearching(true);
    setError("");
    setNotice("");
    try {
      setResults(await searchChannelLocations(channelId, normalizedQuery, language));
    } catch {
      setError(labels.locationSearchFailed);
    } finally {
      setSearching(false);
    }
  };

  const save = async (): Promise<void> => {
    if (!canEdit) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveChannelLocation(channelId, revision, draft);
      onSaved(saved.location, saved.locationRevision);
      setDraft(saved.location);
      setNotice(labels.locationSaved);
    } catch {
      setError(labels.locationSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  const applyTimeZone = async (): Promise<void> => {
    if (!canEdit || draft === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await onSaveChannelTimeZone(draft.timeZone);
      setNotice(labels.locationTimeZoneSaved);
    } catch {
      setError(labels.locationTimeZoneSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  const resultName = (result: PanelChannelLocationResult): string =>
    [result.name, result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", ");

  return (
    <div className="channel-location-field" aria-label={labels.location}>
      <div className="channel-location-field__heading">
        <div><strong>{labels.location}</strong><p className="muted">{labels.locationHint}</p></div>
        {draft === null
          ? <span className="muted">—</span>
          : <span className="channel-location-field__current"><strong>{draft.name}</strong><span className="muted">{draft.latitude.toFixed(4)}, {draft.longitude.toFixed(4)} · {draft.timeZone}</span></span>}
      </div>
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
      {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
      {!canEdit ? null : <>
        <div className="channel-location-field__search">
          <Field label={labels.locationSearch} value={query} onChange={setQuery} disabled={disabled || searching} onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void search();
            }
          }} />
          <Button variant="secondary" disabled={disabled || searching || query.trim().length < 2} onClick={() => { void search(); }}>
            {searching ? labels.locationSearching : labels.locationSearchButton}
          </Button>
        </div>
        {results.length === 0 && !searching && query.trim().length >= 2 ? <p className="muted">{labels.locationNoResults}</p> : null}
        <div className="channel-location-field__results" role="listbox" aria-label={labels.locationResults}>
          {results.map((result) => {
            const selected = draft?.latitude === result.latitude && draft.longitude === result.longitude;
            return <div className="channel-location-field__result" key={`${String(result.latitude)}:${String(result.longitude)}`} role="option" aria-selected={selected}>
              <span><strong>{result.name}</strong>{result.admin1 || result.country ? <span className="muted"> · {[result.admin1, result.country].filter(Boolean).join(", ")}</span> : null}</span>
              <Button size="compact" variant={selected ? "primary" : "subtle"} disabled={disabled || busy} onClick={() => {
                setDraft({ name: resultName(result), latitude: result.latitude, longitude: result.longitude, timeZone: result.timeZone });
                setError("");
                setNotice("");
              }}>{labels.locationSelect}</Button>
            </div>;
          })}
        </div>
        <div className="channel-location-field__actions">
          {draft !== null && value !== null ? <Button variant="secondary" danger="subtle" disabled={disabled || busy} onClick={() => { setDraft(null); }}>
            {labels.locationRemove}
          </Button> : <span />}
          <Button disabled={disabled || busy || (draft?.name === value?.name && draft?.latitude === value?.latitude && draft?.longitude === value?.longitude && draft?.timeZone === value?.timeZone)} onClick={() => { void save(); }}>
            {labels.locationSave}
          </Button>
        </div>
        {draft === null || draft.timeZone === channelTimeZone ? null : <div className="channel-location-field__suggestion">
          <span>{labels.locationTimeZoneSuggestion(draft.timeZone)}</span>
          <Button variant="secondary" disabled={disabled || busy} onClick={() => { void applyTimeZone(); }}>{labels.locationTimeZoneAction}</Button>
        </div>}
      </>}
    </div>
  );
};
