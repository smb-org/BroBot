import type { ReactElement } from "react";
import type { OverlayElementEditorProps } from "../../contract";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig } from "./state";
import "./editor.css";

export default function SongRequestsNowPlayingEditor({ config, onChange, onPreviewState, language = "de", readOnly = false }: OverlayElementEditorProps): ReactElement {
  const value = parseNowPlayingConfig(config) ?? DEFAULT_NOW_PLAYING_CONFIG;
  const copy = nowPlayingTexts[language];
  return <div className="song-requests-now-playing-editor">
    <label><span>{copy.showCover}</span><input type="checkbox" checked={value.showCover} disabled={readOnly} onChange={(event) => onChange({ ...value, showCover: event.currentTarget.checked })} /></label>
    <label><span>{copy.showRequester}</span><input type="checkbox" checked={value.showRequester} disabled={readOnly} onChange={(event) => onChange({ ...value, showRequester: event.currentTarget.checked })} /></label>
    <label><span>{copy.showProgress}</span><input type="checkbox" checked={value.showProgress} disabled={readOnly} onChange={(event) => onChange({ ...value, showProgress: event.currentTarget.checked })} /></label>
    <div className="song-requests-now-playing-editor__preview" aria-label={copy.preview}>
      <span>{copy.preview}</span><strong>Glass Harbor</strong><small>Mira Vale · Song vote · Spotify</small>
    </div>
    {onPreviewState ? <button className="button button--secondary" type="button" disabled={readOnly} onClick={() => onPreviewState({ revision: 1, track: { id: "fictionaltrack01", title: "Glass Harbor", artist: "Mira Vale", coverUrl: null, spotifyUrl: "https://open.spotify.com/track/fictionaltrack01", requester: "Song vote", source: "mod_vote", durationMs: 240000, progressMs: 93000 }, serverNow: new Date().toISOString(), playing: true })}>{copy.preview}</button> : null}
  </div>;
}
