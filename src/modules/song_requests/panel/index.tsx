import { useCallback, useEffect, useRef, useState, type ReactElement, type SubmitEvent } from "react";

import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { dashboardTexts } from "../../../dashboard/locale";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Field,
  LoadState,
  LoadStateLines,
  ListRow,
  SaveStatus,
  Section,
  StatusLed,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
  type StatusLedState,
} from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { songRequestsPanelTexts } from "./locale";
import { readSettings, request, saveSettings } from "./service";
import type { SongRequestsSettingsRead } from "./service";
import "./panel.css";

interface Track {
  id: string;
  title: string;
  artists: readonly string[];
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
  createdAt: string;
}

interface VoteOutcome {
  ballotId: string;
  state: "tie" | "no_votes" | "failed";
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
}

const stateTone = (state: SongRequestState): "neutral" | "green" | "amber" | "red" => {
  if (state === "submitted" || state === "observed_playing") return "green";
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

function EmptyTextSettings({
  channelId,
  language,
  settings,
  canManage,
}: {
  channelId: string;
  language: "de" | "en";
  settings: SongRequestsSettingsRead;
  canManage: boolean;
}): ReactElement {
  const text = songRequestsPanelTexts[language];
  const queryClient = useDashboardQueryClient();
  const draft = useDraft(settings.settings.emptyText);
  const baselineRevision = useRef(settings.revision);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const saveInFlight = useRef<Promise<string | null> | null>(null);

  useEffect(() => {
    if (draft.dirty || baselineRevision.current === settings.revision) return;
    baselineRevision.current = settings.revision;
    draft.accept(settings.settings.emptyText);
    setSaved(false);
  }, [draft.accept, draft.dirty, settings.revision, settings.settings.emptyText]);

  const updateDraft = (value: string): void => {
    draft.setValue(value.slice(0, 80));
    setSaved(false);
    setSaveError(undefined);
  };

  const saveDraft = useCallback((): Promise<string | null> => {
    if (!canManage || !draft.dirty) return Promise.resolve(null);
    if (saveInFlight.current !== null) return saveInFlight.current;
    setPending(true);
    setSaved(false);
    setSaveError(undefined);
    const operation = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite(
          queryClient,
          channelId,
          "song_requests",
          "settings",
          (revision) => saveSettings(channelId, revision ?? baselineRevision.current, draft.value),
          {
            baselineRevision: baselineRevision.current,
            updateCache: (_current, savedSettings) => savedSettings,
          },
        );
        baselineRevision.current = result.revision;
        draft.accept(result.settings.emptyText);
        setSaved(true);
        return null;
      } catch (error: unknown) {
        const message = error instanceof Error && error.message.includes("conflict") ? text.settingsConflict : text.settingsSaveError;
        setSaveError(message);
        return message;
      } finally {
        saveInFlight.current = null;
        setPending(false);
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [canManage, channelId, draft.accept, draft.dirty, draft.value, queryClient, text.settingsConflict, text.settingsSaveError]);

  const draftGuard = useDraftGuard(draft.dirty, saveDraft, draft.reset);
  useEffect(() => registerDashboardNavigationGuard(draftGuard.guardSwitch), [draftGuard.guardSwitch]);
  const navigation = dashboardTexts(language).module;

  return <>
    <Field
      label={text.emptyText}
      value={draft.value}
      onChange={updateDraft}
      maxLength={80}
      countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
      disabled={!canManage || pending}
    />
    {canManage ? <SaveStatus
      dirty={draft.dirty}
      persistent
      pending={pending}
      saved={saved}
      saveDisabled={draft.value.length > 80}
      {...(saveError === undefined ? {} : { error: saveError })}
      onSave={() => { void saveDraft(); }}
      onDiscard={() => { draft.reset(); setSaved(false); setSaveError(undefined); }}
      saveLabel={text.save}
      discardLabel={text.discard}
      savedLabel={text.saved}
      pendingLabel={text.saving}
    /> : null}
    <ConfirmDialog
      opened={draftGuard.confirmOpen}
      title={navigation.unsavedChangesTitle}
      description={navigation.unsavedChangesDescription}
      confirmLabel={navigation.discardAndSwitch}
      cancelLabel={navigation.continueEditing}
      onConfirm={draftGuard.discardAndSwitch}
      onCancel={draftGuard.continueEditing}
      {...(canManage ? { alternative: { label: navigation.saveAndSwitch, onClick: () => { void draftGuard.saveAndSwitch(); } } } : {})}
      pending={draftGuard.saving || pending}
      {...(draftGuard.saveError === undefined ? {} : { error: draftGuard.saveError })}
    />
  </>;
}

export default function SongRequestsPanel({ channelId, language = "de", canManage = false, canOperate = false }: ModulePanelProperties): ReactElement {
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
  const settingsQuery = useModuleQuery<SongRequestsSettingsRead>(
    channelId,
    "song_requests",
    "settings",
    (signal) => readSettings(channelId, signal),
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "searched" | "error">("idle");
  const [selected, setSelected] = useState<Track[]>([]);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState("");

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
    setFeedback("");
    try {
      await operation();
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : "";
      setFeedback(code === "chat_vote_already_open" ? text.busy : code === "stream_offline" ? text.offline : text.error);
    } finally {
      setPending(false);
    }
  };

  const submitSearch = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const searchQuery = query.trim();
    if (searchQuery.length === 0 || pending || searchState === "loading" || connection?.state !== "connected" || !canOperate) return;
    setSearchState("loading");
    setResults([]);
    setFeedback("");
    try {
      const response = await request<{ tracks: Track[] }>(channelId, `search?q=${encodeURIComponent(searchQuery)}`);
      setResults(response.tracks);
      setSearchState("searched");
    } catch {
      setSearchState("error");
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

  const requestQueryStatus = requestsQuery.data === undefined
    ? requestsQuery.isError ? "error" : "loading"
    : requests.length === 0 ? "empty" : "success";
  const settingsQueryStatus = settingsQuery.data === undefined
    ? settingsQuery.isError ? "error" : "loading"
    : "success";
  const canConnect = canManage && connection?.enabled === true && !connection.hasCredentials;
  const canReconnect = canManage && connection?.enabled === true && connection.hasCredentials;
  const canDisconnect = canManage && connection?.hasCredentials === true;

  return <div className="song-requests-panel">
    <div className="song-requests-panel__feedback" role="status" aria-live="polite">{feedback || " "}</div>

    <Section title={text.connection} className="song-requests-panel__connection-section">
      <div className="song-requests-panel__connection-copy">
        <div className="song-requests-panel__connection-status" aria-live="polite">
          <StatusLed state={connectionLedState} label={text.connection} dotOnly />
          <span title={connectionMessage}>{connectionMessage}</span>
        </div>
        <div className="song-requests-panel__actions">
          {canConnect ? <Button variant="primary" disabled={pending} onClick={connect}>{text.connect}</Button> : null}
          {canReconnect ? <Button variant="secondary" disabled={pending} onClick={connect}>{text.reconnectButton}</Button> : null}
          {canDisconnect ? <Button variant="neutral" disabled={pending} onClick={disconnect}>{text.disconnect}</Button> : null}
        </div>
      </div>
      <div className="song-requests-panel__slot-count" aria-live="polite">
        {connection?.enabled === true && connection.slot !== null ? `${text.usedSlots}: ${String(connection.slot)} / 5` : " "}
      </div>
    </Section>

    <Section title={text.search}>
      <form className="song-requests-panel__search" onSubmit={(event) => { void submitSearch(event); }}>
        <Field
          label={text.query}
          value={query}
          onChange={(value) => { setQuery(value.slice(0, 200)); setSearchState("idle"); setResults([]); }}
          normalize={(value) => value.slice(0, 200)}
          disabled={!canOperate || connection?.state !== "connected" || pending || searchState === "loading"}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <Button
          variant="secondary"
          size="compact"
          icon="search"
          ariaLabel={text.searchButton}
          className="song-requests-panel__search-button"
          type="submit"
          disabled={!canOperate || connection?.state !== "connected" || pending || searchState === "loading" || query.trim().length === 0}
        ><span className="song-requests-panel__search-button-label">{text.searchButton}</span></Button>
      </form>
    </Section>

    <Section
      title={`${text.selected} (${String(selected.length)}/5)`}
      className="song-requests-panel__candidate-section"
      headingAction={<Button
        variant="primary"
        disabled={pending || !canOperate || selected.length < 2 || selected.length > 5 || connection?.state !== "connected"}
        onClick={startVote}
      >{text.startVote}</Button>}
    >
      {selected.length === 0 ? <EmptyState title={text.emptyCandidates} description={text.emptyCandidatesDescription} /> :
        <div className="song-requests-panel__list" role="list" aria-label={text.selected}>
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
                onClick={() => { setSelected((current) => current.filter((item) => item.id !== track.id)); }}
              />}
            />
          </div>)}
        </div>}
    </Section>

    <Section title={text.searchResults} className="song-requests-panel__results-section">
      {searchState === "loading" ? <LoadStateLines rows={3} height={44} /> : null}
      {searchState === "searched" && results.length === 0 ? <EmptyState title={text.emptyResults} description={text.emptyResultsDescription} /> : null}
      {searchState === "searched" && results.length > 0 ? <div className="song-requests-panel__list" role="list" aria-label={text.searchResults}>
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
                disabled={alreadySelected || selected.length >= 5 || pending}
                onClick={() => { addTrack(track); }}
              >{alreadySelected ? text.added : text.add}</Button>}
            />
          </div>;
        })}
      </div> : null}
      <div className="song-requests-panel__search-feedback" role="status" aria-live="polite">
        {searchState === "error" ? text.searchError : " "}
      </div>
    </Section>

    {canViewRequests ? <Section title={text.recent}>
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
            {requests.map((requestRow) => <div role="listitem" key={requestRow.requestId}>
              <ListRow
                href={requestRow.spotifyUrl}
                onNavigate={() => { window.open(requestRow.spotifyUrl, "_blank", "noopener,noreferrer"); }}
                title={requestRow.title}
                description={requestRow.artists.join(", ")}
                status={<Badge tone={stateTone(requestRow.state)}>{text.states[requestRow.state]}</Badge>}
                action={requestRow.state === "outcome_unknown" && canOperate
                  ? <span className="song-requests-panel__resolution">
                    <Button size="compact" variant="secondary" disabled={pending} onClick={() => { resolveRequest(requestRow.requestId, "submitted"); }}>{text.resolveIn}</Button>
                    <Button size="compact" variant="secondary" disabled={pending} onClick={() => { resolveRequest(requestRow.requestId, "failed"); }}>{text.resolveOut}</Button>
                  </span>
                  : null}
              />
            </div>)}
          </div>
      </LoadState>
      <h3 className="song-requests-panel__subheading">{text.recentVotes}</h3>
      {voteOutcomes.length === 0 ? <EmptyState title={text.emptyVoteOutcomes} description="" /> : <div className="song-requests-panel__outcomes" role="list" aria-label={text.recentVotes}>
        {voteOutcomes.map((outcome) => <div className="song-requests-panel__outcome" role="listitem" key={outcome.ballotId}>
          <Badge tone={outcome.state === "failed" ? "red" : "amber"}>{text.voteOutcomes[outcome.state]}</Badge>
          <time dateTime={outcome.createdAt}>{formatOutcomeTime(outcome.createdAt, activeLanguage)}</time>
        </div>)}
      </div>}
    </Section> : null}

    <Section title={text.settings} className="song-requests-panel__settings">
      <LoadState
        variant="status-row"
        status={settingsQueryStatus}
        loading={<LoadStateLines rows={1} height={44} />}
        empty={null}
        error={<p role="alert">{text.settingsLoadError}</p>}
        queryError={{ message: text.settingsLoadError, onRetry: () => { void settingsQuery.refetch(); } }}
        refreshError={settingsQuery.isRefetchError}
      >
        {settingsQuery.data === undefined ? null : <EmptyTextSettings
          key={channelId}
          channelId={channelId}
          language={activeLanguage}
          settings={settingsQuery.data}
          canManage={canManage}
        />}
      </LoadState>
    </Section>
  </div>;
}
