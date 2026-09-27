import { useState, type ReactElement } from "react";

import {
  saveChannelLocation,
  searchChannelLocations,
  type PanelChannelLocation,
  type PanelChannelLocationResult,
} from "./api";
import { channelSettingsTexts } from "./channel-settings-locale";
import { Button, ConfirmDialog, Dialog, Field } from "./ui";

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
  const [opened, setOpened] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PanelChannelLocationResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");

  const search = async (): Promise<void> => {
    const normalizedQuery = query.trim();
    if (!canEdit || normalizedQuery.length < 2) return;
    setSearching(true);
    setDialogError("");
    try {
      setResults(await searchChannelLocations(channelId, normalizedQuery, language));
    } catch {
      setDialogError(labels.locationSearchFailed);
    } finally {
      setSearching(false);
    }
  };

  // location === null only happens via the remove ConfirmDialog (outside the main dialog),
  // selecting a search result only happens while the main dialog is open — branch on that
  // to route the error message to the right surface.
  const save = async (location: PanelChannelLocation | null): Promise<void> => {
    if (!canEdit || busy) return;
    setBusy(true);
    setNotice("");
    if (location === null) setError(""); else setDialogError("");
    try {
      const saved = await saveChannelLocation(channelId, revision, location);
      onSaved(saved.location, saved.locationRevision);
      setNotice(location === null ? labels.locationRemoved : labels.locationSaved);
      setOpened(false);
      setRemoveConfirmation(false);
      setQuery("");
      setResults([]);
    } catch {
      if (location === null) setError(labels.locationSaveFailed);
      else setDialogError(labels.locationSaveFailed);
      setRemoveConfirmation(false);
    } finally {
      setBusy(false);
    }
  };

  const applyTimeZone = async (): Promise<void> => {
    if (!canEdit || value === null) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await onSaveChannelTimeZone(value.timeZone);
      setNotice(labels.locationTimeZoneSaved);
    } catch {
      setError(labels.locationTimeZoneSaveFailed);
    } finally {
      setBusy(false);
    }
  };

  const resultName = (result: PanelChannelLocationResult): string =>
    [result.name, result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", ");
  const locked = !canEdit ? labels.readOnly : null;
  const actionsDisabled = disabled || busy || !canEdit;
  const removeDisabledReason = !canEdit ? labels.readOnly : value === null ? labels.locationNotSet : null;

  return (
    <div className="channel-location-field" aria-label={labels.location}>
      <div className="channel-location-field__heading">
        <div><strong>{labels.location}</strong><p className="muted">{labels.locationHint}</p></div>
        {value === null
          ? <span className="muted">—</span>
          : <span className="channel-location-field__current"><strong>{value.name}</strong><span className="muted">{value.latitude.toFixed(4)}, {value.longitude.toFixed(4)} · {value.timeZone}</span></span>}
      </div>
      {error.length === 0 ? null : <p className="form-error" role="alert">{error}</p>}
      {notice.length === 0 ? null : <p className="muted" role="status">{notice}</p>}
      <div className="channel-location-field__actions">
        <Button
          variant="primary"
          disabled={actionsDisabled}
          {...(locked === null ? {} : { describedBy: "channel-location-read-only" })}
          onClick={() => { setOpened(true); setError(""); setDialogError(""); setResults([]); setNotice(""); }}
        >{labels.locationChange}</Button>
        <Button
          variant="secondary"
          danger="subtle"
          disabled={actionsDisabled || value === null}
          {...(removeDisabledReason === null ? {} : { describedBy: "channel-location-remove-reason" })}
          onClick={() => { setRemoveConfirmation(true); setError(""); }}
        >{labels.locationRemove}</Button>
      </div>
      {locked === null ? null : <p className="lock-reason" id="channel-location-read-only">{locked}</p>}
      {removeDisabledReason === null ? null : <p className="lock-reason" id="channel-location-remove-reason">{removeDisabledReason}</p>}
      {value === null || value.timeZone === channelTimeZone ? null : <div className="channel-location-field__suggestion">
        <span>{labels.locationTimeZoneSuggestion(value.timeZone)}</span>
        <Button
          variant="secondary"
          disabled={actionsDisabled}
          {...(locked === null ? {} : { describedBy: "channel-location-read-only" })}
          onClick={() => { void applyTimeZone(); }}
        >{labels.locationTimeZoneAction}</Button>
      </div>}

      <Dialog
        opened={opened}
        onClose={() => { if (!busy) setOpened(false); }}
        title={labels.locationChange}
        pending={busy}
      >
        <div className="channel-location-dialog">
          <p className="muted">{labels.locationHint}</p>
          {locked === null ? null : <p className="lock-reason" id="channel-location-dialog-read-only">{locked}</p>}
          <div className="channel-location-field__search">
            <Field label={labels.locationSearch} value={query} onChange={setQuery} disabled={actionsDisabled || searching} onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }} />
            <Button
              variant="secondary"
              disabled={actionsDisabled || searching || query.trim().length < 2}
              {...(!canEdit ? { describedBy: "channel-location-dialog-read-only" } : {})}
              onClick={() => { void search(); }}
            >
              {searching ? labels.locationSearching : labels.locationSearchButton}
            </Button>
          </div>
          {dialogError.length === 0 ? null : <p className="form-error" role="alert">{dialogError}</p>}
          {searching ? <p className="muted" role="status">{labels.locationSearching}</p> : null}
          {results.length === 0 && !searching && dialogError.length === 0 && query.trim().length >= 2 ? <p className="muted">{labels.locationNoResults}</p> : null}
          <div className="channel-location-field__results" role="listbox" aria-label={labels.locationResults}>
            {results.map((result) => {
              const selected = value !== null && value.latitude === result.latitude && value.longitude === result.longitude;
              return <button
                className="channel-location-field__result"
                key={`${String(result.latitude)}:${String(result.longitude)}`}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={actionsDisabled || searching}
                onClick={() => { void save({ name: resultName(result), latitude: result.latitude, longitude: result.longitude, timeZone: result.timeZone }); }}
              >
                <span><strong>{result.name}</strong>{result.admin1 || result.country ? <span className="muted"> · {[result.admin1, result.country].filter(Boolean).join(", ")}</span> : null}</span>
                <span className="channel-location-field__result-action">{labels.locationSelect}</span>
              </button>;
            })}
          </div>
          <a className="muted" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{labels.locationAttribution}</a>
        </div>
      </Dialog>
      <ConfirmDialog
        opened={removeConfirmation}
        title={labels.locationRemoveTitle}
        description={labels.locationRemoveDescription}
        confirmLabel={labels.locationRemove}
        cancelLabel={labels.cancel}
        danger
        pending={busy}
        onConfirm={() => { void save(null); }}
        onCancel={() => { if (!busy) setRemoveConfirmation(false); }}
      />
    </div>
  );
};
