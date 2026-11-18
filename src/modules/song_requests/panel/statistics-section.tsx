import type { ReactElement } from "react";

import type { ModuleStatisticsSectionProperties } from "../../contract";
import { useModuleQuery } from "../../../dashboard/data";
import { EmptyState, LoadStateLines } from "../../../dashboard/ui";
import type { SongRequestStatistics } from "../contracts";
import { formatSongRequestTrack } from "../domain/track-display";
import { readSongRequestStatistics } from "./service";
import "./panel.css";

const labels = {
  de: {
    requesters: "Top-Anfragende",
    tracks: "Meistgewünschte Titel",
    count: "Anfragen",
    empty: "Noch keine angenommenen Wünsche.",
    error: "Song-Wunsch-Statistiken konnten nicht geladen werden.",
    loading: "Song-Wunsch-Statistiken werden geladen.",
  },
  en: {
    requesters: "Top requesters",
    tracks: "Most requested tracks",
    count: "Requests",
    empty: "No accepted requests yet.",
    error: "Song request statistics could not be loaded.",
    loading: "Loading song request statistics.",
  },
} as const;

export default function SongRequestStatisticsSection({ channelId, language, scope }: ModuleStatisticsSectionProperties): ReactElement {
  const text = labels[language];
  const statistics = useModuleQuery<SongRequestStatistics>(
    channelId,
    "song_requests",
    `statistics:${scope.kind === "stream" ? scope.streamId : "total"}`,
    (signal) => readSongRequestStatistics(channelId, scope, signal),
  );
  const number = new Intl.NumberFormat(language);

  return <div className="song-request-statistics" aria-busy={statistics.isFetching}>
    <div className="song-request-statistics__status" role={statistics.isError ? "alert" : "status"} aria-live="polite">
      {statistics.isError ? text.error : statistics.isPending ? text.loading : " "}
    </div>
    {statistics.isPending ? <div className="song-request-statistics__columns" aria-label={text.loading}>
      {["requesters", "tracks"].map((key) => <div className="song-request-statistics__list" key={key}>
        <LoadStateLines rows={10} height={30} />
      </div>)}
    </div> : statistics.data === undefined ? <div className="song-request-statistics__reserved" aria-hidden="true" />
      : statistics.data.requesters.length === 0 && statistics.data.tracks.length === 0 ? <div className="song-request-statistics__reserved"><EmptyState title={text.empty} description="" /></div>
        : <div className="song-request-statistics__columns">
          <section className="song-request-statistics__list" aria-label={text.requesters}>
            <h3>{text.requesters}</h3>
            {statistics.data.requesters.length === 0 ? <p className="song-request-statistics__empty">{text.empty}</p> : <ol>
              {statistics.data.requesters.map((requester) => <li key={requester.userId}>
                <span className="song-request-statistics__name">{requester.displayName}</span>
                <span className="song-request-statistics__count" aria-label={`${number.format(requester.count)} ${text.count}`}>{number.format(requester.count)}</span>
              </li>)}
            </ol>}
          </section>
          <section className="song-request-statistics__list" aria-label={text.tracks}>
            <h3>{text.tracks}</h3>
            {statistics.data.tracks.length === 0 ? <p className="song-request-statistics__empty">{text.empty}</p> : <ol>
              {statistics.data.tracks.map((track) => <li key={track.trackId}>
                <span className="song-request-statistics__name">
                  <strong>{formatSongRequestTrack(track)}</strong>
                </span>
                <span className="song-request-statistics__count" aria-label={`${number.format(track.count)} ${text.count}`}>{number.format(track.count)}</span>
              </li>)}
            </ol>}
          </section>
        </div>}
  </div>;
}
