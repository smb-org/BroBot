import { createPortal } from "react-dom";
import { useEffect, useState, type ReactElement } from "react";
import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Button, Field } from "../../../dashboard/ui";
import { songRequestsActionTexts } from "./action-locale";
import { request } from "./service";

interface Track { id: string; title: string; artists: readonly string[] }
interface Readiness { enabled: boolean; state: string; streamId: string | null }

export default function SongRequestsCockpitAction({ channelId, language, onDraftChange, onReadinessChange, onActionExecute, footerElement }: ModuleImmediateActionContentProperties): ReactElement {
  const text = songRequestsActionTexts[language];
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
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
  useEffect(() => { onReadinessChange?.(ready, loading ? text.loading : ready ? null : text.unavailable); }, [ready, loading, text.loading, text.unavailable, onReadinessChange]);
  const search = async (): Promise<void> => {
    if (!ready || query.trim().length === 0) return;
    setBusy(true); setError("");
    try {
      const response = await request<{ tracks: Track[] }>(channelId, `search?q=${encodeURIComponent(query)}`);
      setResults(response.tracks);
    } catch { setError(text.failed); }
    finally { setBusy(false); }
  };
  const execute = async (): Promise<void> => {
    if (selected.length < 2 || selected.length > 5 || onActionExecute === undefined) return;
    setBusy(true); setError("");
    try {
      const form = footerElement?.closest("form");
      if (form === null || form === undefined) return;
      const data = new FormData(form);
      for (const track of selected) data.append("trackId", track.id);
      await onActionExecute(data);
      setSelected([]);
      onDraftChange?.(false);
    } catch { setError(text.error); }
    finally { setBusy(false); }
  };
  return <>
    <div className="live-action-content song-requests-cockpit-action">
      <Field label={text.query} value={query} disabled={!ready || busy} normalize={(value) => value.slice(0, 200)} onChange={(value) => { setQuery(value); onDraftChange?.(true); }} />
      <Button variant="secondary" type="button" disabled={!ready || busy || query.trim().length === 0} onClick={() => { void search(); }}>{text.searchButton}</Button>
      {results.map((track) => <div className="song-requests-cockpit-action__track" key={track.id}><span>{track.title} · {track.artists.join(", ")}</span><Button variant="secondary" type="button" disabled={selected.length >= 5 || selected.some(({ id }) => id === track.id)} onClick={() => { setSelected((current) => [...current, track]); onDraftChange?.(true); }}>{text.add}</Button></div>)}
      <p>{text.selected} ({selected.length}/5)</p>
      <ol>{selected.map((track) => <li key={track.id}>{track.title} · {track.artists.join(", ")} <button type="button" aria-label={`Remove ${track.title}`} onClick={() => { setSelected((current) => current.filter(({ id }) => id !== track.id)); }}>×</button></li>)}</ol>
      <p role="status" aria-live="polite">{error || (loading ? text.loading : ready ? " " : text.unavailable)}</p>
    </div>
    {footerElement === null || footerElement === undefined ? null : createPortal(<Button variant="primary" type="button" disabled={!ready || selected.length < 2 || selected.length > 5 || busy || onActionExecute === undefined} onClick={() => { void execute(); }}>{busy ? text.loading : text.run}</Button>, footerElement)}
  </>;
}
