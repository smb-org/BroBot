import { useState, type ReactElement, type SubmitEvent } from "react";

import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import {
  ActionMenu,
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  LoadState,
  LoadStateLines,
  ListRow,
  Section,
  StatusLed,
  Icon,
  notify,
  type StatusLedState,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { songRequestsPanelTexts } from "./locale";
import { formatSongRequestTrack } from "../domain/track-display";
import { request } from "./service";
import SongRequestChaptersPage from "./chapters-page";
import SongRequestRecapPage from "./recap-page";
import "./panel.css";

interface Track {
  id: string;
  title: string;
  artists: readonly string[];
  albumName?: string | null;
  coverUrl: string | null;
  spotifyUrl: string;
}

type SongRequestState = "pending_review" | "approved" | "submitting" | "submitted" | "observed_playing" |
  "not_observed" | "outcome_unknown" | "rejected" | "removed" | "failed";

interface RequestRow extends Track {
  requestId: string;
  state: SongRequestState;
  failureReason: string | null;
  source: string;
  requestType: "vote" | "bot_points" | "free" | "channel_points";
  chargedAmount: number;
  requesterDisplayName: string | null;
  requesterLogin: string | null;
  createdAt: string;
}

interface VoteOutcome {
  ballotId: string;
  state: "tie" | "no_votes" | "failed" | "drawn";
  drawnByLot: boolean;
  createdAt: string;
}

interface Connection {
  enabled: boolean;
  hasCredentials: boolean;
  slot: number | null;
  state: string;
  errorMessage: string | null;
  streamId: string | null;
  emptyText: string;
}

interface RequestsRead {
  requests: RequestRow[];
  voteOutcomes: VoteOutcome[];
  nowPlayingRequestId: string | null;
}

const stateTone = (state: SongRequestState, nowPlaying = false): "neutral" | "green" | "amber" | "red" => {
  if (state === "submitted" || (state === "observed_playing" && nowPlaying)) return "green";
  if (state === "observed_playing") return "neutral";
  if (state === "failed" || state === "rejected" || state === "removed") return "red";
  if (state === "pending_review" || state === "approved" || state === "submitting" || state === "outcome_unknown") return "amber";
  return "neutral";
};

const formatOutcomeTime = (value: string, language: "de" | "en"): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date);
};

function SongRequestsRequestsPanel({ channelId, language = "de", canManage = false, canOperate = false }: ModulePanelProperties): ReactElement {
  const activeLanguage: "de" | "en" = language === "en" ? "en" : "de";
  const text = songRequestsPanelTexts[activeLanguage];
  const queryClient = useDashboardQueryClient();
  const canViewRequests = canOperate || canManage;
  const connectionQuery = useModuleQuery<Connection>(
    channelId,
    "song_requests",
    "connection",
    (signal) => request<Connection>(channelId, "connection", "GET", undefined, signal),
  );
  const requestsQuery = useModuleQuery<RequestsRead>(
    channelId,
    "song_requests",
    "requests",
    (signal) => request<RequestsRead>(channelId, "requests", "GET", undefined, signal),
    { enabled: canViewRequests },
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "searched">("idle");
  const [selected, setSelected] = useState<Track[]>([]);
  const [pending, setPending] = useState(false);
  const [clearListOpen, setClearListOpen] = useState(false);
  const [removal, setRemoval] = useState<{ requestId: string; refund: boolean; label: string; description: string } | null>(null);

  const connection = connectionQuery.data ?? null;
  const requestData = requestsQuery.data;
  const requests = canViewRequests ? requestData?.requests ?? [] : [];
  const voteOutcomes = canViewRequests ? requestData?.voteOutcomes ?? [] : [];
  const connectionMessage = connection === null
    ? connectionQuery.isError ? text.connectionLoadError : text.connecting
    : !connection.enabled ? text.notEnabled
      : connection.state === "connected" ? text.connected
        : connection.state === "spotify_error" ? connection.errorMessage ?? text.notConnected
          : connection.state === "premium_required" ? text.premium
            : connection.state === "no_active_device" ? text.device
              : connection.state === "reconnect_required" ? text.reconnect
                : text.notConnected;
  const connectionLedState: StatusLedState = connection === null
    ? connectionQuery.isError ? "error" : "loading"
    : !connection.enabled || connection.state === "not_connected" ? "off"
      : connection.state === "connected" ? "ok"
        : connection.state === "spotify_error" ? "error" : "warn";

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (pending) return;
    setPending(true);
    try {
      await operation();
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : "";
      notify({ tone: "error", message: code === "chat_vote_already_open" ? text.busy : code === "stream_offline" ? text.offline : text.error });
    } finally {
      setPending(false);
    }
  };

  const submitSearch = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const searchQuery = query.trim();
    if (searchQuery.length === 0 || pending || searchState === "loading" || searchBlocked) return;
    setSearchState("loading");
    try {
      const response = await request<{ tracks: Track[] }>(channelId, `search?q=${encodeURIComponent(searchQuery)}`);
      setResults(response.tracks);
      setSearchState("searched");
    } catch {
      setSearchState(results.length > 0 ? "searched" : "idle");
      notify({ tone: "error", message: text.searchError });
    }
  };

  const addTrack = (track: Track): void => {
    setSelected((current) => current.some((item) => item.id === track.id) || current.length >= 5 ? current : [...current, track]);
  };

  const connect = (): void => {
    void run(async () => {
      const result = await request<{ authorizationUrl: string }>(channelId, "oauth/start", "POST");
      window.location.assign(result.authorizationUrl);
    });
  };

  const disconnect = (): void => {
    void run(async () => {
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "song_requests",
        "connection",
        () => request<{ state: string }>(channelId, "disconnect", "POST"),
        {
          baselineRevision: null,
          updateCache: (current) => {
            if (typeof current !== "object" || current === null) return current;
            return { ...current, state: "not_connected", hasCredentials: false, errorMessage: null };
          },
        },
      );
    });
  };

  const startVote = (): void => {
    void run(async () => {
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "song_requests",
        "requests",
        () => request(channelId, "vote", "POST", { trackIds: selected.map(({ id }) => id) }),
        { baselineRevision: null, updateCache: (current) => current },
      );
      setSelected([]);
    });
  };

  const resolveRequest = (requestId: string, state: "submitted" | "failed"): void => {
    void run(async () => {
      await runModuleQueryWrite(
        queryClient,
        channelId,
        "song_requests",
        "requests",
        () => request(channelId, `requests/${encodeURIComponent(requestId)}/resolve`, "POST", { state }),
        { baselineRevision: null, updateCache: (current) => current },
      );
    });
  };

  const removeRequest = (requestId: string, refund: boolean): void => {
    void run(async () => {
      await request(channelId, `requests/${encodeURIComponent(requestId)}/remove`, "POST", { refund });
      await requestsQuery.refetch();
    });
  };

  const clearList = (): void => {
    void run(async () => {
      await request(channelId, "clear", "POST");
      setClearListOpen(false);
      await requestsQuery.refetch();
      notify({ tone: "success", message: text.listCleared });
    });
  };

  const requestQueryStatus = requestsQuery.data === undefined
    ? requestsQuery.isError ? "error" : "loading"
    : requests.length === 0 ? "empty" : "success";
  const canConnect = canManage && connection?.enabled === true && !connection.hasCredentials;
  const canReconnect = canManage && connection?.enabled === true && connection.hasCredentials;
  const canDisconnect = canManage && connection?.enabled === true && connection.hasCredentials;
  const needsAttention = connection !== null && connection.state !== "connected" && connection.state !== "not_connected";
  // Searching and voting do not need an active device, only a working Spotify link.
  const searchBlocked = !canOperate || (connection?.state !== "connected" && connection?.state !== "no_active_device");
  const voteBlocked = pending || searchBlocked || selected.length < 2 || selected.length > 5;

  return <div className="song-requests-panel">
    <Section title={text.connection} className="song-requests-panel__connection-section">
      <div className="song-requests-panel__connection-copy">
        <div className="song-requests-panel__connection-status" aria-live="polite">
          <StatusLed state={connectionLedState} label={text.connection} dotOnly />
          <span title={connectionMessage}>{connectionMessage}</span>
        </div>
        <div className="song-requests-panel__actions">
          {canConnect ? <Button variant="primary" disabled={pending} onClick={connect}>{text.connect}</Button> : null}
          {canReconnect ? <Button variant={needsAttention ? "primary" : "secondary"} disabled={pending} onClick={connect}>{text.reconnectButton}</Button> : null}
          {canDisconnect ? <Button variant="secondary" disabled={pending} onClick={disconnect}>{text.disconnect}</Button> : null}
        </div>
      </div>
      {connection?.enabled === true && connection.slot !== null
        ? <div className="song-requests-panel__slot-count">{`${text.usedSlots}: ${String(connection.slot)} / 5`}</div>
        : null}
    </Section>

    <Section title={text.search}>
      <form className="song-requests-panel__search" onSubmit={(event) => { void submitSearch(event); }}>
        <Field
          label={text.query}
          value={query}
          onChange={(value) => { setQuery(value.slice(0, 200)); }}
          normalize={(value) => value.slice(0, 200)}
          disabled={searchBlocked || pending || searchState === "loading"}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <Button
          variant="secondary"
          icon="search"
          ariaLabel={text.searchButton}
          className="song-requests-panel__search-button"
          type="submit"
          disabled={searchBlocked || pending || searchState === "loading" || query.trim().length === 0}
        ><span className="song-requests-panel__search-button-label">{text.searchButton}</span></Button>
      </form>
    </Section>

    {searchState === "idle" ? null : <Section title={text.searchResults} className="song-requests-panel__results-section">
      {searchState === "loading" ? <LoadStateLines rows={3} height={44} /> : null}
      {searchState === "searched" && results.length === 0 ? <EmptyState title={text.emptyResults} description={text.emptyResultsDescription} /> : null}
      {searchState === "searched" && results.length > 0 ? <div className="song-requests-panel__list" role="list" aria-label={text.searchResults}>
        {results.map((track) => {
          const alreadySelected = selected.some((item) => item.id === track.id);
          return <div role="listitem" key={track.id}>
            <ListRow
              href={track.spotifyUrl}
              onNavigate={() => { window.open(track.spotifyUrl, "_blank", "noopener,noreferrer"); }}
              title={formatSongRequestTrack(track)}
              description={track.artists.join(", ")}
              status={null}
              action={alreadySelected
                ? <span className="song-requests-panel__added"><Icon name="copied" size={16} />{text.added}</span>
                : <Button
                  variant="secondary"
                  size="compact"
                  ariaLabel={text.addTrack(track.title)}
                  disabled={selected.length >= 5 || pending}
                  onClick={() => { addTrack(track); }}
                >{text.add}</Button>}
            />
          </div>;
        })}
      </div> : null}
    </Section>}

    <Section
      title={`${text.selected} (${String(selected.length)}/5)`}
      className="song-requests-panel__candidate-section"
      headingAction={<>
        <span className="ui-section__rule" aria-hidden="true" />
        <Button variant="primary" disabled={voteBlocked} onClick={startVote}>{text.startVote}</Button>
      </>}
    >
      {selected.length === 0 ? <EmptyState title={text.emptyCandidates} description={text.emptyCandidatesDescription} /> :
        <div className="song-requests-panel__list" role="list" aria-label={text.selected}>
          {selected.map((track) => <div role="listitem" key={track.id}>
            <ListRow
              href={track.spotifyUrl}
              onNavigate={() => { window.open(track.spotifyUrl, "_blank", "noopener,noreferrer"); }}
              title={formatSongRequestTrack(track)}
              description={track.artists.join(", ")}
              status={<Badge tone="brand">{text.candidate}</Badge>}
              action={<Button
                variant="subtle"
                danger="subtle"
                size="compact"
                icon="remove"
                iconOnly
                ariaLabel={text.removeTrack(track.title)}
                onClick={() => { setSelected((current) => current.filter((item) => item.id !== track.id)); }}
              />}
            />
          </div>)}
        </div>}
    </Section>

    {canViewRequests ? <Section title={text.recent} headingAction={canOperate ? <Button variant="secondary" disabled={pending} onClick={() => { setClearListOpen(true); }}>{text.clearList}</Button> : null}>
      <LoadState
        variant="panel-0"
        status={requestQueryStatus}
        loading={<LoadStateLines rows={3} height={40} />}
        empty={<EmptyState title={text.emptyRequests} description={text.emptyRequestsDescription} />}
        error={<p role="alert">{text.requestLoadError}</p>}
        queryError={{ message: text.requestLoadError, onRetry: () => { void requestsQuery.refetch(); } }}
        refreshError={requestsQuery.isRefetchError}
      >
          <div className="song-requests-panel__list" role="list" aria-label={text.recent}>
            {requests.map((requestRow) => {
              const nowPlaying = requestRow.state === "observed_playing" && requestRow.requestId === requestData?.nowPlayingRequestId;
              const requester = requestRow.requesterDisplayName || requestRow.requesterLogin;
              const attribution = requester || (requestRow.requestType === "vote" ? text.recap.songVote : null);
              const description = [requestRow.artists.join(", "), attribution]
                .filter((part): part is string => part !== null && part.length > 0).join(" · ");
              const beforeSubmit = requestRow.state === "pending_review" || requestRow.state === "approved";
              const afterSubmit = requestRow.state === "submitted" || requestRow.state === "outcome_unknown";
              const paid = requestRow.requestType === "bot_points" && requestRow.chargedAmount > 0;
              const action = !canOperate || (!beforeSubmit && !afterSubmit) ? null : (() => {
                const items = [
                  { label: text.remove, disabled: pending, onSelect: () => { setRemoval({ requestId: requestRow.requestId, refund: false, label: text.remove, description: beforeSubmit ? (paid ? text.removeConfirmBeforePaid : text.removeConfirmBefore) : text.removeConfirmAfter }); } },
                  ...(afterSubmit && paid ? [{ label: text.removeRefund, disabled: pending, onSelect: () => { setRemoval({ requestId: requestRow.requestId, refund: true, label: text.removeRefund, description: text.removeConfirmRefund }); } }] : []),
                  ...(requestRow.state === "outcome_unknown" ? [
                    { divider: true as const },
                    { label: text.resolveIn, disabled: pending, onSelect: () => { resolveRequest(requestRow.requestId, "submitted"); } },
                    { label: text.resolveOut, disabled: pending, onSelect: () => { resolveRequest(requestRow.requestId, "failed"); } },
                  ] : []),
                ];
                return <ActionMenu label={`${text.requestActions}: ${requestRow.title}`} items={items} />;
              })();
              return <div role="listitem" key={requestRow.requestId}>
                <ListRow
                  href={requestRow.spotifyUrl}
                  onNavigate={() => { window.open(requestRow.spotifyUrl, "_blank", "noopener,noreferrer"); }}
                  icon={requestRow.coverUrl === null ? <Icon name="music" size={20} /> : <img className="song-requests-cover" src={requestRow.coverUrl} alt="" />}
                  title={requestRow.title}
                  description={description}
                  status={<Badge tone={stateTone(requestRow.state, nowPlaying)}>{requestRow.state === "observed_playing" ? (nowPlaying ? text.states.observed_playing : text.states.played) : text.states[requestRow.state]}</Badge>}
                  action={action}
                />
              </div>;
            })}
          </div>
      </LoadState>
    </Section> : null}

    {canViewRequests ? <Section title={text.recentVotes}>
      {voteOutcomes.length === 0 ? <EmptyState title={text.emptyVoteOutcomes} description="" /> : <div className="song-requests-panel__outcomes" role="list" aria-label={text.recentVotes}>
        {voteOutcomes.map((outcome) => <div className="song-requests-panel__outcome" role="listitem" key={outcome.ballotId}>
          <Badge tone={outcome.state === "failed" ? "red" : "amber"}>{text.voteOutcomes[outcome.state]}</Badge>
          <time dateTime={outcome.createdAt}>{formatOutcomeTime(outcome.createdAt, activeLanguage)}</time>
        </div>)}
      </div>}
    </Section> : null}

    <ConfirmDialog opened={removal !== null} title={text.removeConfirmTitle} description={removal?.description ?? ""}
      confirmLabel={removal?.label ?? text.remove} cancelLabel={text.cancel} danger pending={pending}
      onConfirm={() => { if (removal !== null) removeRequest(removal.requestId, removal.refund); setRemoval(null); }}
      onCancel={() => { setRemoval(null); }} />
    <ConfirmDialog opened={clearListOpen} title={text.clearConfirmTitle} description={text.clearConfirmDescription}
      confirmLabel={text.clearConfirm} cancelLabel={text.cancel} onConfirm={clearList} onCancel={() => { setClearListOpen(false); }}
      pending={pending} danger />
  </div>;
}

export default function SongRequestsPanel(properties: ModulePanelProperties): ReactElement {
  if (properties.pageId === "chapters") return <SongRequestChaptersPage key={`${properties.channelId}:chapters`} {...properties} />;
  if (properties.pageId === "recap") return <SongRequestRecapPage key={`${properties.channelId}:recap`} {...properties} />;
  return <SongRequestsRequestsPanel key={`${properties.channelId}:requests`} {...properties} />;
}
