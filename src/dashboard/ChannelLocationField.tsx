import { useState, type ReactElement } from "react";

import {
  saveChannelLocation,
  searchChannelLocations,
  type PanelChannelLocation,
  type PanelChannelLocationResult,
} from "./api";
import { channelSettingsTexts } from "./channel-settings-locale";
import { Button, ConfirmDialog, Dialog, Field, LoadState, notify, Skeleton } from "./ui";

interface ChannelLocationFieldProperties {
  channelId: string;
  language: "de" | "en";
  value: PanelChannelLocation | null;
  revision: number;
  onSaved: (location: PanelChannelLocation | null, revision: number) => void | Promise<void>;
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
  const [searchFailed, setSearchFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);

  const search = async (): Promise<void> => {
    const normalizedQuery = query.trim();
    if (!canEdit || normalizedQuery.length < 2) return;
    setSearching(true);
    setSearchFailed(false);
    try {
      setResults(await searchChannelLocations(channelId, normalizedQuery, language));
    } catch {
      setResults([]);
      setSearchFailed(true);
      notify({ tone: "error", message: labels.locationSearchFailed });
    } finally {
      setSearching(false);
    }
  };

  const save = async (location: PanelChannelLocation | null): Promise<void> => {
    if (!canEdit || busy) return;
    setBusy(true);
    setConfirmError(undefined);
    try {
      const saved = await saveChannelLocation(channelId, revision, location);
      await onSaved(saved.location, saved.locationRevision);
      notify({ tone: "success", message: location === null ? labels.locationRemoved : labels.locationSaved });
      setOpened(false);
      setRemoveConfirmation(false);
      setQuery("");
      setResults([]);
    } catch {
      if (location === null) setConfirmError(labels.locationSaveFailed);
      else notify({ tone: "error", message: labels.locationSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  const applyTimeZone = async (): Promise<void> => {
    if (!canEdit || value === null) return;
    setBusy(true);
    try {
      await onSaveChannelTimeZone(value.timeZone);
      notify({ tone: "success", message: labels.locationTimeZoneSaved });
    } catch {
      notify({ tone: "error", message: labels.locationTimeZoneSaveFailed });
    } finally {
      setBusy(false);
    }
  };

  const resultName = (result: PanelChannelLocationResult): string =>
    [result.name, result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", ");
  const locked = !canEdit ? labels.readOnly : null;
  const actionsDisabled = disabled || busy || !canEdit;
  const removeDisabledReason = !canEdit ? labels.readOnly : value === null ? labels.locationNotSet : null;
  const resultsStatus = searching ? "loading" : searchFailed ? "error" : query.trim().length >= 2 && results.length > 0 ? "success" : "empty";

  return (
    <div className="channel-location-field" aria-label={labels.location}>
      <div className="channel-location-field__heading">
        <div><strong>{labels.location}</strong><p className="muted">{labels.locationHint}</p></div>
        <span className="channel-location-field__current" aria-live="polite">
          {value === null ? <span className="muted">—</span> : <>
            <strong title={value.name}>{value.name}</strong>
            <span className="muted">{value.latitude.toFixed(4)}, {value.longitude.toFixed(4)} · {value.timeZone}</span>
          </>}
        </span>
      </div>
      <div className="channel-location-field__message-slot" aria-live="polite" />
      <div className="channel-location-field__actions">
        <Button
          variant="primary"
          disabled={actionsDisabled}
          {...(locked === null ? {} : { describedBy: "channel-location-read-only" })}
          onClick={() => { setOpened(true); setSearchFailed(false); setResults([]); }}
        >{labels.locationChange}</Button>
        <Button
          variant="secondary"
          danger="subtle"
          disabled={actionsDisabled || value === null}
          {...(removeDisabledReason === null ? {} : { describedBy: "channel-location-remove-reason" })}
          onClick={() => { setConfirmError(undefined); setRemoveConfirmation(true); }}
        >{labels.locationRemove}</Button>
      </div>
      <div className="channel-location-field__reason-slot">
        {locked === null ? null : <p className="lock-reason" id="channel-location-read-only">{locked}</p>}
        {removeDisabledReason === null ? null : <p className="lock-reason" id="channel-location-remove-reason">{removeDisabledReason}</p>}
      </div>
      <div className="channel-location-field__suggestion-slot">
        {value === null || value.timeZone === channelTimeZone ? null : <div className="channel-location-field__suggestion">
          <span>{labels.locationTimeZoneSuggestion(value.timeZone)}</span>
          <Button
            variant="secondary"
            disabled={actionsDisabled}
            {...(locked === null ? {} : { describedBy: "channel-location-read-only" })}
            onClick={() => { void applyTimeZone(); }}
          >{labels.locationTimeZoneAction}</Button>
        </div>}
      </div>

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
            <Field label={labels.locationSearch} value={query} onChange={(nextQuery) => { setQuery(nextQuery); setResults([]); setSearchFailed(false); }} disabled={actionsDisabled || searching} onKeyDown={(event) => {
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
          <LoadState
            variant="panel"
            status={resultsStatus}
            minHeight={178}
            loading={<Skeleton rows={3} height={54} />}
            empty={query.trim().length >= 2 && !searchFailed ? <p className="muted">{labels.locationNoResults}</p> : <span aria-hidden="true" />}
            error={<Skeleton rows={3} height={54} />}
          >
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
          </LoadState>
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
        onCancel={() => { if (!busy) { setConfirmError(undefined); setRemoveConfirmation(false); } }}
        {...(confirmError === undefined ? {} : { error: confirmError })}
      />
    </div>
  );
};
