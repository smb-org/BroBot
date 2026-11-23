import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ModuleOverlayElementProps } from "../../contract";
import { SONG_REQUESTS_NOW_PLAYING_SIZE } from "./kinds";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig, parseNowPlayingState } from "./state";
import { formatPlaybackTime, interpolatePlaybackProgress } from "../domain/playback";
import "./view.css";

// Keeps the empty line boxes at full height so the card does not shift when a track appears.
const RESERVED_LINE = " ";

export default function SongRequestsNowPlaying({ config: rawConfig, state: rawState, now: initialNow, language = "de", editorPreview = false }: ModuleOverlayElementProps): ReactElement {
  const config = parseNowPlayingConfig(rawConfig) ?? DEFAULT_NOW_PLAYING_CONFIG;
  const state = parseNowPlayingState(rawState);
  const track = state?.playing === false ? null : state?.track ?? null;
  const trackId = state?.track?.id ?? null;
  const playing = state?.playing !== false && state?.track !== null && state?.track !== undefined;
  const previousTrackId = useRef(trackId);
  const [shownTrackId, setShownTrackId] = useState<string | null>(null);
  const [now, setNow] = useState(() => initialNow);
  const progressDurationMs = track?.durationMs;
  const progressAnchorMs = track?.progressMs;
  const serverNow = state?.serverNow;
  useEffect(() => {
    if ((!config.showProgress && !config.showTime) || progressDurationMs === undefined || progressAnchorMs == null || serverNow === undefined || !playing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [config.showProgress, config.showTime, serverNow, playing, progressDurationMs, progressAnchorMs]);
  // Pausing ends the timed display; resuming the same track must not show it again.
  if (!playing && shownTrackId !== null) setShownTrackId(null);
  useEffect(() => {
    if (trackId === previousTrackId.current) return;
    previousTrackId.current = trackId;
    setShownTrackId(config.displayMode === "on_change" && trackId !== null && playing ? trackId : null);
  }, [config.displayMode, trackId, playing]);
  useEffect(() => {
    if (config.displayMode !== "on_change" || !playing || trackId === null || shownTrackId !== trackId) return;
    const timer = window.setTimeout(() => {
      setShownTrackId((current) => current === trackId ? null : current);
    }, config.showDurationSeconds * 1_000);
    return () => window.clearTimeout(timer);
  }, [config.displayMode, config.showDurationSeconds, playing, shownTrackId, trackId]);
  const text = nowPlayingTexts[language];
  const emptyText = state?.emptyText ?? "";
  const idle = track === null && emptyText.trim().length === 0;
  const visible = editorPreview || (config.displayMode === "always"
    ? !idle
    : config.displayMode === "playing"
      ? playing
      : playing && trackId !== null && shownTrackId === trackId);
  const hidden = !visible;
  const hasProgress = track !== null && track.durationMs !== undefined && track.progressMs != null && state !== null;
  const progressMs = hasProgress
    ? interpolatePlaybackProgress(track.progressMs as number, track.durationMs as number, Date.parse(state.serverNow), now)
    : 0;
  const progressPercent = hasProgress && track.durationMs
    ? Math.min(100, Math.max(0, progressMs / track.durationMs * 100))
    : 0;
  return <section
    className={`song-requests-now-playing${config.showAlbum ? " song-requests-now-playing--album" : ""}${hidden ? " song-requests-now-playing--hidden" : ""}`}
    style={SONG_REQUESTS_NOW_PLAYING_SIZE}
    aria-label={hidden ? undefined : text.name}
    aria-hidden={hidden || undefined}
    data-testid="song-requests-now-playing"
  >
    {config.showCover ? <div className="song-requests-now-playing__cover">{track?.coverUrl ? <img src={track.coverUrl} alt="" /> : null}</div> : null}
    <div className="song-requests-now-playing__copy">
      {config.showTitle ? <h2 className="song-requests-now-playing__title" title={track?.title ?? emptyText}>{track ? <a href={track.spotifyUrl} target="_blank" rel="noreferrer">{track.title}</a> : emptyText || RESERVED_LINE}</h2> : null}
      {config.showArtist ? <p className="song-requests-now-playing__artist" title={track?.artist ?? ""}>{track?.artist ?? RESERVED_LINE}</p> : null}
      {config.showAlbum ? <p className="song-requests-now-playing__album" title={track?.album ?? ""}>{track?.album ?? RESERVED_LINE}</p> : null}
      {config.showRequester ? <p className="song-requests-now-playing__requester" title={track ? (track.source === "mod_vote" ? text.requester : track.requester ?? "") : ""}>{track ? (track.source === "mod_vote" ? text.requester : track.requester ?? RESERVED_LINE) : RESERVED_LINE}</p> : null}
      {config.showProgress || config.showTime ? <div className="song-requests-now-playing__progress" aria-hidden={!hasProgress || undefined}>
        {config.showTime ? <span className="song-requests-now-playing__time">{hasProgress ? `${formatPlaybackTime(progressMs)} / ${formatPlaybackTime(track.durationMs ?? 0)}` : RESERVED_LINE}</span> : null}
        {config.showProgress ? <div className="song-requests-now-playing__progress-track" role={hasProgress ? "progressbar" : undefined}
          aria-label={hasProgress ? text.progress : undefined} aria-valuemin={hasProgress ? 0 : undefined}
          aria-valuemax={hasProgress ? 100 : undefined} aria-valuenow={hasProgress ? Math.round(progressPercent) : undefined}>
          <span style={{ width: `${String(progressPercent)}%` }} />
        </div> : null}
      </div> : null}
    </div>
    {track ? <span className="song-requests-now-playing__spotify">{text.spotify}</span> : <span className="song-requests-now-playing__spotify" aria-hidden="true">{RESERVED_LINE}</span>}
  </section>;
}
