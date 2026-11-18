import { useState, type ReactElement } from "react";

import { useChannelSettings, useModuleQuery } from "../../../dashboard/data";
import { DataTable, EmptyState, LoadState, LoadStateLines, Select, type SelectOption } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import { request } from "./service";
import { songRequestsPanelTexts } from "./locale";
import "./panel.css";

interface RecapStream {
  streamId: string;
  latestAt: string;
  playedCount: number;
}

interface RecapStreamsResponse {
  streams: RecapStream[];
  selectedStreamId: string | null;
}

interface RecapRequest {
  requestId: string;
  observedAt: string;
  title: string;
  artists: string[];
  spotifyUrl: string;
  requester: string;
}

interface RecapResponse {
  streamId: string;
  requests: RecapRequest[];
}

export default function SongRequestRecapPage({ channelId, language = "de", canManage = false, canOperate = false }: ModulePanelProperties): ReactElement {
  const activeLanguage: "de" | "en" = language === "en" ? "en" : "de";
  const text = songRequestsPanelTexts[activeLanguage].recap;
  const allowed = canManage || canOperate;
  const streamsQuery = useModuleQuery<RecapStreamsResponse>(channelId, "song_requests", "recap", (signal) =>
    request<RecapStreamsResponse>(channelId, "recap/streams", "GET", undefined, signal), { enabled: allowed });
  const streams = streamsQuery.data?.streams ?? [];
  const [pickedStreamId, setSelectedStreamId] = useState<string | null>(null);
  // A pick that is no longer listed falls back to the server's default stream.
  const selectedStreamId = pickedStreamId !== null && streams.some(({ streamId }) => streamId === pickedStreamId)
    ? pickedStreamId
    : streamsQuery.data?.selectedStreamId ?? null;

  const recapQueryPart = `recap:${selectedStreamId ?? "pending"}`;
  const recapRoutePart = `recap?streamId=${encodeURIComponent(selectedStreamId ?? "")}`;
  const recapQuery = useModuleQuery<RecapResponse>(
    channelId,
    "song_requests",
    recapQueryPart,
    (signal) => request<RecapResponse>(channelId, recapRoutePart, "GET", undefined, signal),
    { enabled: allowed && selectedStreamId !== null },
  );
  const channelSettings = useChannelSettings(channelId);
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone = channelSettings.data?.timeZone ?? (browserTimeZone.length === 0 ? "UTC" : browserTimeZone);
  const locale = activeLanguage === "de" ? "de-DE" : "en-US";
  const options = streams.map((stream): SelectOption => {
    const date = new Date(stream.latestAt);
    let label = stream.streamId;
    try {
      if (!Number.isNaN(date.getTime())) label = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium", timeStyle: "short", timeZone: channelSettings.data?.timeZone ?? "UTC",
      }).format(date);
    } catch { /* Keep the stream identifier when the saved timezone is invalid. */ }
    return { value: stream.streamId, label: `${label} · ${String(stream.playedCount)}` };
  });
  const rows = (recapQuery.data?.requests ?? []).map((row) => ({
    id: row.requestId,
    at: row.observedAt,
    moduleGroup: "song_requests",
    track: row,
  }));

  if (!allowed) return <div className="song-requests-panel"><EmptyState title={text.accessRequired} description="" /></div>;

  return <section className="song-requests-panel song-requests-recap" aria-labelledby="song-requests-recap-title">
    <header className="song-requests-recap__heading"><h1 id="song-requests-recap-title">{text.title}</h1></header>
    <div className="song-requests-recap__toolbar">
      <Select label={text.streams} value={selectedStreamId} onChange={setSelectedStreamId} options={options}
        placeholder={text.noStreams} disabled={streams.length === 0 || streamsQuery.isFetching} />
    </div>
    <div className="song-requests-recap__content" aria-live="polite">
      {streamsQuery.isLoading ? <LoadStateLines rows={5} height={42} />
        : streamsQuery.isError ? <p role="alert">{text.loadError}</p>
          : streams.length === 0 ? <EmptyState title={text.noStreams} description="" />
            : selectedStreamId === null ? <LoadStateLines rows={5} height={42} />
              : <LoadState
                variant="panel-420"
                status={recapQuery.data !== undefined ? "success" : recapQuery.isError ? "error" : "loading"}
                loading={<LoadStateLines rows={7} height={40} />}
                empty={<EmptyState title={text.noRequests} description="" />}
                error={<p role="alert">{text.loadError}</p>}
                queryError={{ message: text.loadError, onRetry: () => { void recapQuery.refetch(); } }}
                refreshError={recapQuery.isRefetchError}
              >
                <DataTable
                  ariaLabel={text.title}
                  rows={rows}
                  columns={[
                    { key: "track", label: text.track, render: (row) => <>
                      <a className="song-requests-recap__track" href={row.track.spotifyUrl} target="_blank" rel="noreferrer">
                        <strong>{row.track.title}</strong><span>{row.track.artists.join(", ")}</span>
                      </a>
                      <span className="song-requests-recap__requester-mobile">{row.track.requester}</span>
                    </> },
                    { key: "requester", label: text.requester, hideOnMobile: true, render: (row) => row.track.requester, width: "180px" },
                  ]}
                  timeZone={timeZone}
                  emptyLabel={text.noRequests}
                  className="song-requests-recap__table"
                />
              </LoadState>}
    </div>
  </section>;
}
