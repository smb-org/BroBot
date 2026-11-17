import { useEffect, useState, type ReactElement } from "react";
import type { ModuleOverlayElementProps } from "../../contract";
import { SONG_REQUESTS_NOW_PLAYING_SIZE } from "./kinds";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig, parseNowPlayingState } from "./state";
import { formatPlaybackTime, interpolatePlaybackProgress } from "../domain/playback";
import "./view.css";

// Keeps the empty line boxes at full height so the card does not shift when a track appears.
const RESERVED_LINE = " ";

export default function SongRequestsNowPlaying({ config: rawConfig, state: rawState, now: initialNow, language = "de" }: ModuleOverlayElementProps): ReactElement {
  const config = parseNowPlayingConfig(rawConfig) ?? DEFAULT_NOW_PLAYING_CONFIG;
  const state = parseNowPlayingState(rawState);
  const track = state?.playing === false ? null : state?.track ?? null;
  const [now, setNow] = useState(() => initialNow);
  const progressDurationMs = track?.durationMs;
  const progressAnchorMs = track?.progressMs;
  const serverNow = state?.serverNow;
  const playing = state?.playing;
  useEffect(() => {
    if (!config.showProgress || progressDurationMs === undefined || progressAnchorMs == null || serverNow === undefined || playing === false) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [config.showProgress, serverNow, playing, progressDurationMs, progressAnchorMs]);
  const text = nowPlayingTexts[language];
  const emptyText = state?.emptyText ?? "";
  const idle = track === null && emptyText.trim().length === 0;
  const hasProgress = track !== null && track.durationMs !== undefined && track.progressMs != null && state !== null;
  const progressMs = hasProgress
    ? interpolatePlaybackProgress(track.progressMs as number, track.durationMs as number, Date.parse(state.serverNow), now)
    : 0;
  const progressPercent = hasProgress && track.durationMs
    ? Math.min(100, Math.max(0, progressMs / track.durationMs * 100))
    : 0;
  return <section
    className={`song-requests-now-playing${idle ? " song-requests-now-playing--idle" : ""}`}
    style={{ ...SONG_REQUESTS_NOW_PLAYING_SIZE, ...(idle ? { visibility: "hidden" as const } : {}) }}
    aria-label={idle ? undefined : text.name}
    aria-hidden={idle || undefined}
    data-testid="song-requests-now-playing"
  >
    {config.showCover ? <div className="song-requests-now-playing__cover">{track?.coverUrl ? <img src={track.coverUrl} alt="" /> : null}</div> : null}
    <div className="song-requests-now-playing__copy">
      <h2 title={track?.title ?? emptyText}>{track ? <a href={track.spotifyUrl} target="_blank" rel="noreferrer">{track.title}</a> : emptyText}</h2>
      <p title={track?.artist ?? ""}>{track?.artist ?? ""}</p>
      {config.showRequester && track ? <p className="song-requests-now-playing__requester" title={track.source === "mod_vote" ? text.requester : track.requester ?? ""}>{track.source === "mod_vote" ? text.requester : track.requester ?? ""}</p> : <p className="song-requests-now-playing__requester" aria-hidden="true">{RESERVED_LINE}</p>}
      {config.showProgress ? <div className="song-requests-now-playing__progress" aria-hidden={!hasProgress || undefined}>
        <span>{hasProgress ? `${formatPlaybackTime(progressMs)} / ${formatPlaybackTime(track.durationMs ?? 0)}` : RESERVED_LINE}</span>
        <div className="song-requests-now-playing__progress-track" role={hasProgress ? "progressbar" : undefined}
          aria-label={hasProgress ? text.progress : undefined} aria-valuemin={hasProgress ? 0 : undefined}
          aria-valuemax={hasProgress ? 100 : undefined} aria-valuenow={hasProgress ? Math.round(progressPercent) : undefined}>
          <span style={{ width: `${String(progressPercent)}%` }} />
        </div>
      </div> : null}
    </div>
    {track ? <span className="song-requests-now-playing__spotify">{text.spotify}</span> : <span className="song-requests-now-playing__spotify" aria-hidden="true">{RESERVED_LINE}</span>}
  </section>;
}
