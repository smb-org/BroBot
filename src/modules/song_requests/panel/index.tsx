import { useState, type ReactElement } from "react";
import type { ModulePanelProperties } from "../../contract";
import { useModuleQuery } from "../../../dashboard/data";
import { Field } from "../../../dashboard/ui";
import { songRequestsPanelTexts } from "./locale";
import { readSettings, request, saveSettings } from "./service";
import "./panel.css";

interface Track { id: string; title: string; artists: readonly string[]; coverUrl: string | null; spotifyUrl: string }
interface RequestRow extends Track { requestId: string; state: string; failureReason: string | null; source: string }
interface VoteOutcome { ballotId: string; state: "tie" | "no_votes" | "failed"; createdAt: string }
interface Connection { enabled: boolean; hasCredentials: boolean; slot: number | null; state: string; errorMessage: string | null; streamId: string | null; emptyText: string }
interface RequestsRead { requests: RequestRow[]; voteOutcomes?: VoteOutcome[] }

const POLL_INTERVAL_MS = 12_000;

export default function SongRequestsPanel({ channelId, language = "de", canManage = false, canOperate = false }: ModulePanelProperties): ReactElement {
  const text = songRequestsPanelTexts[language];
  const canViewRequests = canOperate || canManage;
  const connectionQuery = useModuleQuery(channelId, "song_requests", "connection", (signal) => request<Connection>(channelId, "connection", "GET", undefined, signal), { refetchInterval: canViewRequests ? POLL_INTERVAL_MS : false });
  const requestsQuery = useModuleQuery(channelId, "song_requests", "requests", (signal) => request<RequestsRead>(channelId, "requests", "GET", undefined, signal), { enabled: canViewRequests, refetchInterval: POLL_INTERVAL_MS });
  const settingsQuery = useModuleQuery(channelId, "song_requests", "settings", (signal) => readSettings(channelId, signal));
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [selected, setSelected] = useState<Track[]>([]);
  const [emptyTextDraft, setEmptyTextDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const connection = connectionQuery.data ?? null;
  const requests = canViewRequests ? requestsQuery.data?.requests ?? [] : [];
  const voteOutcomes = canViewRequests ? requestsQuery.data?.voteOutcomes ?? [] : [];
  const savedEmptyText = settingsQuery.data?.settings.emptyText;
  const emptyText = emptyTextDraft ?? (typeof savedEmptyText === "string" ? savedEmptyText : "");
  const settingsRevision = settingsQuery.data?.revision ?? null;
  const refresh = async (): Promise<void> => {
    await Promise.all([connectionQuery.refetch(), canViewRequests ? requestsQuery.refetch() : Promise.resolve()]);
  };
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setFeedback("");
    try { await operation(); }
    catch (error) {
      const code = error instanceof Error ? error.message : "";
      setFeedback(code === "chat_vote_already_open" ? text.busy : code === "stream_offline" ? text.offline : text.error);
    } finally { setBusy(false); }
  };
  const loadFailed = connectionQuery.isError;
  const stateMessage = connection === null ? (loadFailed ? text.error : "") : !connection.enabled ? text.notEnabled : connection.state === "connected" ? text.connected
    : connection.state === "spotify_error" ? connection.errorMessage ?? text.notConnected
      : connection.state === "premium_required" ? text.premium
        : connection.state === "no_active_device" ? text.device : connection.state === "reconnect_required" ? text.reconnect : text.notConnected;
  return <main className="song-requests-panel">
    <header><h1>{text.title}</h1><p>{text.help}</p></header>
    <section className="song-requests-panel__connection" aria-labelledby="song-requests-connection-title">
      <div className="song-requests-panel__section-head"><h2 id="song-requests-connection-title">{text.connection}</h2><span data-state={connection?.state ?? "unknown"}>{stateMessage}</span></div>
      <div className="song-requests-panel__controls">
        {connection?.enabled && canManage ? <button className="button button--primary" type="button" disabled={busy} onClick={() => void run(async () => {
          const result = await request<{ authorizationUrl: string }>(channelId, "oauth/start", "POST");
          window.location.assign(result.authorizationUrl);
        })}>{connection.hasCredentials ? text.reconnectButton : text.connect}</button> : null}
        {connection?.hasCredentials && canManage ? <button className="button button--secondary" type="button" disabled={busy} onClick={() => void run(async () => { await request(channelId, "disconnect", "POST"); await refresh(); })}>{text.disconnect}</button> : null}
      </div>
    </section>
    <section aria-labelledby="song-requests-vote-title">
      <div className="song-requests-panel__section-head"><h2 id="song-requests-vote-title">{text.search}</h2><span>{connection?.enabled && connection.slot !== null ? `${text.usedSlots}: ${String(connection.slot)} / 5` : ""}</span></div>
      <div className="song-requests-panel__search">
        <Field label={text.query} value={query} onChange={setQuery} normalize={(value) => value.slice(0, 200)} />
        <button className="button button--secondary" type="button" disabled={busy || !canOperate || connection?.state !== "connected"} onClick={() => void run(async () => { const response = await request<{ tracks: Track[] }>(channelId, `search?q=${encodeURIComponent(query)}`); setResults(response.tracks); })}>{text.searchButton}</button>
      </div>
      <div className="song-requests-panel__track-list" aria-live="polite">
        {results.length === 0 ? <p>{text.emptyResults}</p> : results.map((track) => <article key={track.id}>
          {track.coverUrl ? <img src={track.coverUrl} alt="" /> : <span className="song-requests-panel__cover" aria-hidden="true" />}
          <span className="song-requests-panel__track-copy"><strong>{track.title}</strong><small>{track.artists.join(", ")}</small></span>
          <button className="button button--secondary" type="button" disabled={selected.some((item) => item.id === track.id) || selected.length >= 5} onClick={() => { setSelected((current) => [...current, track]); }}>{text.add}</button>
        </article>)}
      </div>
      <h3>{text.selected} ({selected.length}/5)</h3>
      <ul className="song-requests-panel__selected">{selected.map((track) => <li key={track.id}><span>{track.title} · {track.artists.join(", ")}</span><button type="button" className="button button--ghost" aria-label={`Remove ${track.title}`} onClick={() => { setSelected((current) => current.filter((item) => item.id !== track.id)); }}>×</button></li>)}</ul>
      <button className="button button--primary" type="button" disabled={busy || !canOperate || selected.length < 2 || selected.length > 5 || connection?.state !== "connected"} onClick={() => void run(async () => { await request(channelId, "vote", "POST", { trackIds: selected.map(({ id }) => id) }); setSelected([]); await refresh(); })}>{text.startVote}</button>
    </section>
    <section aria-labelledby="song-requests-recent-title"><h2 id="song-requests-recent-title">{text.recent}</h2>
      {requests.length === 0 ? <p>{text.emptyRequests}</p> : <ul className="song-requests-panel__requests">{requests.map((row) => <li key={row.requestId}>
        <span className="song-requests-panel__track-copy"><strong>{row.title}</strong><small>{row.artists.join(", ")}</small></span><span>{text.states[row.state as keyof typeof text.states]}</span>
        {row.state === "outcome_unknown" && canOperate ? <span className="song-requests-panel__resolution"><button className="button button--secondary" type="button" onClick={() => void run(async () => { await request(channelId, `requests/${row.requestId}/resolve`, "POST", { state: "submitted" }); await refresh(); })}>{text.resolveIn}</button><button className="button button--secondary" type="button" onClick={() => void run(async () => { await request(channelId, `requests/${row.requestId}/resolve`, "POST", { state: "failed" }); await refresh(); })}>{text.resolveOut}</button></span> : null}
      </li>)}</ul>}
      <h3>{text.recentVotes}</h3>
      {voteOutcomes.length === 0 ? <p>{text.emptyVoteOutcomes}</p> : <ul className="song-requests-panel__requests">{voteOutcomes.map((outcome) => <li key={outcome.ballotId}><span>{text.voteOutcomes[outcome.state]}</span><time dateTime={outcome.createdAt}>{new Date(outcome.createdAt).toLocaleTimeString(language === "de" ? "de-DE" : "en-US", { hour: "2-digit", minute: "2-digit" })}</time></li>)}</ul>}
    </section>
    <section className="song-requests-panel__settings">
      <Field label={text.emptyText} value={emptyText} onChange={setEmptyTextDraft} normalize={(value) => value.slice(0, 80)} disabled={!canManage} />
      <button className="button button--primary" type="button" disabled={busy || !canManage || settingsRevision === null} onClick={() => void run(async () => {
        if (settingsRevision === null) return;
        await saveSettings(channelId, settingsRevision, emptyText);
        setEmptyTextDraft(null);
        await settingsQuery.refetch();
        setFeedback(text.saved);
      })}>{text.save}</button>
    </section>
    <p className="song-requests-panel__feedback" role="status" aria-live="polite">{feedback || " "}</p>
  </main>;
}
