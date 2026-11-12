import { useRef, type ReactElement } from "react";

import { useModuleQuery } from "../../../dashboard/data";
import { Field, Select, UnitInput } from "../../../dashboard/ui";
import type { OverlayElementEditorProps } from "../../contract";
import type { MediaAssetMetadata } from "../contracts";
import { overlayAlertEditorTexts } from "../locale";
import { loadMediaAssets } from "./service";
import "./show-alert-editor.css";

interface ShowAlertActionEditorProperties extends Pick<OverlayElementEditorProps, "language"> {
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  channelId?: string;
}

const placeholders = ["{user}", "{input}", "{reward}"] as const;

const selectedAsset = (config: Readonly<Record<string, unknown>>, key: "imageAssetId" | "soundAssetId"): string | null => {
  const value = config[key];
  return typeof value === "string" ? value : null;
};

const assetOptions = (
  assets: readonly MediaAssetMetadata[],
  kind: "image" | "sound",
  emptyLabel: string,
): { value: string; label: string }[] => [
  { value: "", label: emptyLabel },
  ...assets.filter((asset) => asset.kind === kind).map((asset) => ({ value: asset.id, label: asset.fileName })),
];

export default function ShowAlertActionEditor({ config, onChange, channelId, language = "de" }: ShowAlertActionEditorProperties): ReactElement {
  const copy = overlayAlertEditorTexts[language];
  const inputRef = useRef<HTMLInputElement>(null);
  const text = typeof config.text === "string" ? config.text : "{user} · {reward}";
  const duration = typeof config.durationSeconds === "number" ? config.durationSeconds : 5;
  const volume = typeof config.volumePercent === "number" ? config.volumePercent : 80;
  const assetsQuery = useModuleQuery(
    channelId ?? "",
    "overlay_alerts",
    "data",
    (signal) => loadMediaAssets(channelId ?? "", signal),
    { enabled: channelId !== undefined && channelId.length > 0 },
  );
  const assets = assetsQuery.data ?? [];

  const changeText = (next: string): void => onChange({ ...config, text: next.slice(0, 200) });
  const insert = (placeholder: string): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? text.length;
    const end = input?.selectionEnd ?? start;
    const next = `${text.slice(0, start)}${placeholder}${text.slice(end)}`.slice(0, 200);
    const caret = Math.min(start + placeholder.length, next.length);
    changeText(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  const updateAsset = (key: "imageAssetId" | "soundAssetId", value: string | null): void => {
    const next = { ...config };
    Reflect.deleteProperty(next, key);
    if (value !== null && value.length > 0) next[key] = value;
    onChange(next);
  };

  return <div className="overlay-alert-action-editor">
    <Select
      label={copy.image}
      value={selectedAsset(config, "imageAssetId") ?? ""}
      options={assetOptions(assets, "image", copy.noImage)}
      disabled={assetsQuery.isPending || channelId === undefined}
      busy={assetsQuery.isFetching}
      placeholder={copy.loading}
      onChange={(value) => updateAsset("imageAssetId", value)}
    />
    <Select
      label={copy.sound}
      value={selectedAsset(config, "soundAssetId") ?? ""}
      options={assetOptions(assets, "sound", copy.noSound)}
      disabled={assetsQuery.isPending || channelId === undefined}
      busy={assetsQuery.isFetching}
      placeholder={copy.loading}
      onChange={(value) => updateAsset("soundAssetId", value)}
    />
    {channelId === undefined ? null : <a className="overlay-alert-action-editor__media-link" href={`/channels/${encodeURIComponent(channelId)}/modules/overlay_alerts?lang=${language}`}>
      {copy.mediaLink}
    </a>}
    <div className="overlay-alert-action-editor__status" role={assetsQuery.isError ? "alert" : "status"} aria-live="polite">
      {assetsQuery.isError ? copy.loadFailed : "\u00a0"}
    </div>
    <Field
      inputRef={inputRef}
      label={copy.text}
      value={text}
      maxLength={200}
      countLabel={(count, maximum) => `${String(count)} / ${String(maximum)}`}
      hint={copy.textHint}
      onChange={changeText}
    />
    <span className="ui-field__label" id="overlay-alert-action-placeholders-label">{copy.placeholders}</span>
    <div className="overlay-alert-action-editor__placeholders" role="group" aria-labelledby="overlay-alert-action-placeholders-label">
      {placeholders.map((placeholder) => <button
        key={placeholder}
        type="button"
        className="ui-token-chip"
        aria-label={copy.insertPlaceholder(placeholder)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => insert(placeholder)}
      ><code>{placeholder}</code></button>)}
    </div>
    <UnitInput
      label={copy.duration}
      unit={copy.durationUnit}
      value={duration}
      min={2}
      max={15}
      onChange={(next) => { if (typeof next === "number") onChange({ ...config, durationSeconds: next }); }}
    />
    <UnitInput
      label={copy.volume}
      unit={copy.volumeUnit}
      value={volume}
      min={0}
      max={100}
      onChange={(next) => { if (typeof next === "number") onChange({ ...config, volumePercent: next }); }}
    />
  </div>;
}
