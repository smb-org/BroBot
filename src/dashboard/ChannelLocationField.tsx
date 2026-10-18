import "./ChannelLocationField.css";

import { useState, type ReactElement } from "react";

import {
  searchChannelLocations,
  type PanelChannelLocation,
  type PanelChannelLocationResult,
} from "./api";
import { channelSettingsTexts } from "./channel-settings-locale";
import { Button, ConfirmDialog, Dialog, Field, LoadState, LoadStateLines } from "./ui";

interface ChannelLocationFieldProperties {
  channelId: string;
  language: "de" | "en";
  value: PanelChannelLocation | null;
  onChange: (location: PanelChannelLocation | null) => void;
  channelTimeZone: string;
  onSelectChannelTimeZone: (timeZone: string) => void;
  canEdit: boolean;
  disabled: boolean;
  readOnlyReasonId?: string;
}

export const ChannelLocationField = ({
  channelId,
  language,
  value,
  onChange,
  channelTimeZone,
  onSelectChannelTimeZone,
  canEdit,
  disabled,
  readOnlyReasonId = "channel-location-read-only",
}: ChannelLocationFieldProperties): ReactElement => {
  const labels = channelSettingsTexts(language);
  const [opened, setOpened] = useState(false);
  const [removeConfirmation, setRemoveConfirmation] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PanelChannelLocationResult[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const [searching, setSearching] = useState(false);

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
    } finally {
      setSearching(false);
    }
  };

  const applyTimeZone = (): void => {
    if (!canEdit || value === null) return;
    onSelectChannelTimeZone(value.timeZone);
  };

  const resultName = (result: PanelChannelLocationResult): string =>
    [result.name, result.admin1, result.country].filter((part): part is string => part !== null && part.length > 0).join(", ");
  const actionsDisabled = disabled || !canEdit;
  const resultsStatus = searching ? "loading" : searchFailed ? "error" : query.trim().length >= 2 && results.length > 0 ? "success" : "empty";

  return (
    <div className="channel-location-field" aria-label={labels.location}>
      <div className="channel-location-field__heading">
        <div><p className="muted">{labels.locationHint}</p></div>
        <span className="channel-location-field__current" aria-live="polite">
          {value === null ? null : <>
            <strong className="channel-location-field__place" title={value.name}>{value.name}</strong>
            <span className="muted channel-location-field__coordinates" title={`${String(value.latitude)}, ${String(value.longitude)} · ${value.timeZone}`}>
              {value.latitude.toFixed(2)}, {value.longitude.toFixed(2)} · {value.timeZone}
            </span>
          </>}
        </span>
      </div>
      <div className="channel-location-field__actions">
        <Button variant="secondary" disabled={actionsDisabled}
          {...(!canEdit ? { describedBy: readOnlyReasonId } : {})}
          onClick={() => { setOpened(true); setSearchFailed(false); setResults([]); }}>
          {labels.locationChange}
        </Button>
        <Button variant="subtle" className="channel-location-field__remove" disabled={actionsDisabled || value === null}
          {...(!canEdit ? { describedBy: readOnlyReasonId } : {})}
          onClick={() => { setRemoveConfirmation(true); }}>
          {labels.locationRemove}
        </Button>
      </div>
      {value === null || value.timeZone === channelTimeZone ? null : <div className="channel-location-field__suggestion">
          <span>{labels.locationTimeZoneSuggestion(value.timeZone)}</span>
          <Button variant="secondary" disabled={actionsDisabled}
            {...(!canEdit ? { describedBy: readOnlyReasonId } : {})}
            onClick={applyTimeZone}>
            {labels.locationTimeZoneAction}
          </Button>
        </div>}

      <Dialog opened={opened} onClose={() => { setOpened(false); }} title={labels.locationChange} pending={searching}>
        <div className="channel-location-dialog">
          <p className="muted">{labels.locationHint}</p>
          <div className="channel-location-field__search">
            <Field label={labels.locationSearch} value={query} onChange={(nextQuery) => { setQuery(nextQuery); setResults([]); setSearchFailed(false); }} disabled={actionsDisabled || searching} onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void search();
              }
            }} />
            <Button variant="secondary" disabled={actionsDisabled || searching || query.trim().length < 2}
              {...(!canEdit ? { describedBy: "channel-location-dialog-read-only" } : {})}
              onClick={() => { void search(); }}>
              {searching ? labels.locationSearching : labels.locationSearchButton}
            </Button>
          </div>
          <LoadState variant="panel-178" status={resultsStatus}
            loading={<LoadStateLines rows={3} height={54} />}
            empty={query.trim().length >= 2 && !searchFailed ? <p className="muted">{labels.locationNoResults}</p> : <span aria-hidden="true" />}
            error={<p role="alert" className="channel-location-field__error">{labels.locationSearchFailed}</p>}>
            <div className="channel-location-field__results" role="listbox" aria-label={labels.locationResults}>
              {results.map((result) => {
                const selected = value !== null && value.latitude === result.latitude && value.longitude === result.longitude;
                return <button className="channel-location-field__result"
                  key={`${String(result.latitude)}:${String(result.longitude)}`} type="button" role="option" aria-selected={selected}
                  disabled={actionsDisabled || searching}
                  onClick={() => {
                    onChange({ name: resultName(result), latitude: result.latitude, longitude: result.longitude, timeZone: result.timeZone });
                    setOpened(false);
                    setQuery("");
                    setResults([]);
                  }}>
                  <span><strong>{result.name}</strong>{result.admin1 || result.country ? <span className="muted"> · {[result.admin1, result.country].filter(Boolean).join(", ")}</span> : null}</span>
                  <span className="channel-location-field__result-action">{labels.locationSelect}</span>
                </button>;
              })}
            </div>
          </LoadState>
          <a className="muted" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">{labels.locationAttribution}</a>
        </div>
      </Dialog>
      <ConfirmDialog opened={removeConfirmation} title={labels.locationRemoveTitle} description={labels.locationRemoveDescription}
        confirmLabel={labels.locationRemove} cancelLabel={labels.cancel} danger
        onConfirm={() => { if (actionsDisabled) return; onChange(null); setRemoveConfirmation(false); }}
        onCancel={() => { if (actionsDisabled) return; setRemoveConfirmation(false); }} pending={actionsDisabled} />
    </div>
  );
};
