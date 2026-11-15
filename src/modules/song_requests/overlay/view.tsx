import type { ReactElement } from "react";
import type { ModuleOverlayElementProps } from "../../contract";
import { SONG_REQUESTS_NOW_PLAYING_SIZE } from "./kinds";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig, parseNowPlayingState } from "./state";
import "./view.css";

export default function SongRequestsNowPlaying({ config: rawConfig, state: rawState, language = "de" }: ModuleOverlayElementProps): ReactElement {
  const config = parseNowPlayingConfig(rawConfig) ?? DEFAULT_NOW_PLAYING_CONFIG;
  const state = parseNowPlayingState(rawState);
  const track = state?.track ?? null;
  const text = nowPlayingTexts[language];
  return <section className="song-requests-now-playing" style={SONG_REQUESTS_NOW_PLAYING_SIZE} aria-label={text.name} data-testid="song-requests-now-playing">
    {config.showCover ? <div className="song-requests-now-playing__cover">{track?.coverUrl ? <img src={track.coverUrl} alt="" /> : null}</div> : null}
    <div className="song-requests-now-playing__copy">
      <h2 title={track?.title ?? state?.emptyText ?? ""}>{track ? <a href={track.spotifyUrl} target="_blank" rel="noreferrer">{track.title}</a> : state?.emptyText ?? ""}</h2>
      <p title={track?.artist ?? ""}>{track?.artist ?? ""}</p>
      {config.showRequester && track ? <p className="song-requests-now-playing__requester" title={track.source === "mod_vote" ? text.requester : track.requester ?? ""}>{track.source === "mod_vote" ? text.requester : track.requester ?? ""}</p> : <p className="song-requests-now-playing__requester" aria-hidden="true"> </p>}
    </div>
    {track ? <span className="song-requests-now-playing__spotify">{text.spotify}</span> : <span className="song-requests-now-playing__spotify" aria-hidden="true"> </span>}
  </section>;
}
