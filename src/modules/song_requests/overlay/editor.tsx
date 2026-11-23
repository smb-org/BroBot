import type { ReactElement } from "react";
import type { OverlayElementEditorProps } from "../../contract";
import { Select, SwitchRow, UnitInput } from "../../../dashboard/ui";
import { nowPlayingTexts } from "./locale";
import { DEFAULT_NOW_PLAYING_CONFIG, parseNowPlayingConfig } from "./state";
import "./editor.css";

export default function SongRequestsNowPlayingEditor({ config, onChange, onPreviewState, language = "de", readOnly = false }: OverlayElementEditorProps): ReactElement {
  const value = parseNowPlayingConfig(config) ?? DEFAULT_NOW_PLAYING_CONFIG;
  const copy = nowPlayingTexts[language];
  const durationActive = value.displayMode === "on_change";
  return <div className="song-requests-now-playing-editor overlay-editor__module-fields">
    <Select label={copy.displayMode} value={value.displayMode} disabled={readOnly}
      options={[
        { value: "always", label: copy.always },
        { value: "playing", label: copy.playing },
        { value: "on_change", label: copy.onChange },
      ]}
      onChange={(mode) => {
        if (!readOnly && (mode === "always" || mode === "playing" || mode === "on_change")) onChange({ ...value, displayMode: mode });
      }} />
    <div className="song-requests-now-playing-editor__duration-slot" aria-hidden={!durationActive} style={{ visibility: durationActive ? "visible" : "hidden" }}>
      <UnitInput label={copy.showDurationSeconds} ariaLabel={`${copy.showDurationSeconds} (${copy.seconds})`} unit={copy.seconds}
        value={value.showDurationSeconds} min={2} max={60} step={1} disabled={readOnly || !durationActive} commitOnBlurOrEnter
        onChange={(next) => {
          if (!readOnly && durationActive && typeof next === "number") {
            onChange({ ...value, showDurationSeconds: Math.max(2, Math.min(60, Math.trunc(next))) });
          }
        }} />
    </div>
    <SwitchRow label={copy.showCover} checked={value.showCover} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showCover: checked }); }} />
    <SwitchRow label={copy.showTitle} checked={value.showTitle} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showTitle: checked }); }} />
    <SwitchRow label={copy.showArtist} checked={value.showArtist} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showArtist: checked }); }} />
    <SwitchRow label={copy.showAlbum} checked={value.showAlbum} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showAlbum: checked }); }} />
    <SwitchRow label={copy.showProgress} checked={value.showProgress} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showProgress: checked }); }} />
    <SwitchRow label={copy.showTime} checked={value.showTime} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showTime: checked }); }} />
    <SwitchRow label={copy.showRequester} checked={value.showRequester} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...value, showRequester: checked }); }} />
    {onPreviewState ? <button className="button button--secondary" type="button" disabled={readOnly} onClick={() => onPreviewState({ revision: 1, track: { id: "fictionaltrack01", title: "Glass Harbor", artist: "Mira Vale", album: "Quiet Water", coverUrl: null, spotifyUrl: "https://open.spotify.com/track/fictionaltrack01", requester: "Song vote", source: "mod_vote", durationMs: 240000, progressMs: 93000 }, serverNow: new Date().toISOString(), playing: true })}>{copy.preview}</button> : null}
  </div>;
}
