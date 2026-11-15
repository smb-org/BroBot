import { createPortal } from "react-dom";
import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Badge, Button, EmptyState, Field, ListRow } from "../../../dashboard/ui";
import { songRequestsActionTexts } from "./action-locale";
import { request } from "./service";
import "./panel.css";

interface Track {
  id: string;
  title: string;
  artists: readonly string[];
  spotifyUrl: string;
}

interface Readiness {
  enabled: boolean;
  state: string;
  streamId: string | null;
}

type ActionText = (typeof songRequestsActionTexts)[keyof typeof songRequestsActionTexts];

export default function SongRequestsCockpitAction({ channelId, language, onDraftChange, onReadinessChange, onActionExecute, footerElement }: ModuleImmediateActionContentProperties): ReactElement {
  const text = songRequestsActionTexts[language];
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void request<Readiness>(channelId, "connection", "GET", undefined, controller.signal)
      .then((state) => { if (!controller.signal.aborted) setReady(state.enabled && state.state === "connected" && state.streamId !== null); })
      .catch(() => { if (!controller.signal.aborted) setError(text.unavailable); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [channelId, text.unavailable]);

  useEffect(() => {
    onReadinessChange?.(ready, loading ? text.loading : ready ? null : text.unavailable);
  }, [ready, loading, text.loading, text.unavailable, onReadinessChange]);

  const search = async (): Promise<void> => {
    if (!ready || query.trim().length === 0 || busy) return;
    setBusy(true);
    setError("");
    setSearched(false);
    setResults([]);
    try {
      const response = await request<{ tracks: Track[] }>(channelId, `search?q=${encodeURIComponent(query.trim())}`);
      setResults(response.tracks);
      setSearched(true);
    } catch {
      setError(text.failed);
    } finally {
      setBusy(false);
    }
  };

  const execute = async (): Promise<void> => {
    if (selected.length < 2 || selected.length > 5 || onActionExecute === undefined) return;
    setBusy(true);
    setError("");
    try {
      const form = footerElement?.closest("form");
      if (form === null || form === undefined) return;
      const data = new FormData(form);
      for (const track of selected) data.append("trackId", track.id);
      await onActionExecute(data);
      setSelected([]);
      onDraftChange?.(false);
    } catch {
      setError(text.error);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <div className="live-action-content song-requests-cockpit-action">
      <div className="song-requests-panel__search" role="group" aria-label={text.search}>
        <Field
          label={text.query}
          value={query}
          disabled={!ready || busy}
          normalize={(value) => value.slice(0, 200)}
          onChange={(value) => { setQuery(value); setSearched(false); setResults([]); }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void search();
          }}
        />
        <Button
          variant="secondary"
          size="compact"
          icon="search"
          ariaLabel={text.searchButton}
          className="song-requests-panel__search-button"
          disabled={!ready || busy || query.trim().length === 0}
          onClick={() => { void search(); }}
        ><span className="song-requests-panel__search-button-label">{text.searchButton}</span></Button>
      </div>
      {searched && results.length === 0 ? <EmptyState title={text.emptyResults} description="" /> : null}
      {results.length > 0 ? <div className="song-requests-panel__list" role="list" aria-label={text.search}>
        {results.map((track) => {
          const alreadySelected = selected.some((item) => item.id === track.id);
          return <div role="listitem" key={track.id}>
            <ListRow
              href={track.spotifyUrl}
              onNavigate={() => { window.open(track.spotifyUrl, "_blank", "noopener,noreferrer"); }}
              title={track.title}
              description={track.artists.join(", ")}
              status={alreadySelected ? <Badge tone="brand">{text.candidate}</Badge> : null}
              action={<Button
                variant="secondary"
                size="compact"
                ariaLabel={text.addTrack(track.title)}
                disabled={alreadySelected || selected.length >= 5 || busy}
                onClick={() => {
                  setSelected((current) => current.some((item) => item.id === track.id) || current.length >= 5 ? current : [...current, track]);
                  onDraftChange?.(true);
                }}
              >{alreadySelected ? text.added : text.add}</Button>}
            />
          </div>;
        })}
      </div> : null}
      <p className="live-action-content__status song-requests-cockpit-action__feedback" role="status" aria-live="polite">
        {error || (loading ? text.loading : ready ? " " : text.unavailable)}
      </p>
      <SectionCandidates selected={selected} text={text} busy={busy} onRemove={(trackId) => {
        setSelected((current) => current.filter(({ id }) => id !== trackId));
        onDraftChange?.(selected.length > 1);
      }} />
    </div>
    {footerElement === null || footerElement === undefined ? null : createPortal(
      <Button variant="primary" type="button" disabled={!ready || selected.length < 2 || selected.length > 5 || busy || onActionExecute === undefined} onClick={() => { void execute(); }}>
        {busy ? text.loading : text.run}
      </Button>,
      footerElement,
    )}
  </>;
}

function SectionCandidates({
  selected,
  text,
  busy,
  onRemove,
}: {
  selected: readonly Track[];
  text: ActionText;
  busy: boolean;
  onRemove: (trackId: string) => void;
}): ReactElement {
  return <div className="song-requests-cockpit-action__candidates">
    <strong>{text.selected} ({String(selected.length)}/5)</strong>
    {selected.length === 0 ? <p className="live-action-content__status">{text.emptyCandidates}</p> : <div className="song-requests-panel__list" role="list" aria-label={text.selected}>
      {selected.map((track) => <div role="listitem" key={track.id}>
        <ListRow
          href={track.spotifyUrl}
          onNavigate={() => { window.open(track.spotifyUrl, "_blank", "noopener,noreferrer"); }}
          title={track.title}
          description={track.artists.join(", ")}
          status={<Badge tone="brand">{text.candidate}</Badge>}
          action={<Button
            variant="subtle"
            danger="subtle"
            size="compact"
            icon="remove"
            iconOnly
            ariaLabel={text.removeTrack(track.title)}
            disabled={busy}
            onClick={() => { onRemove(track.id); }}
          />}
        />
      </div>)}
    </div>}
  </div>;
}
