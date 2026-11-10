import { useEffect, useRef, useState, type DragEvent, type Dispatch, type ReactElement, type SetStateAction } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { runModuleQueryWrite, useDashboardQueryClient, useModuleQuery } from "../../../dashboard/data";
import { Button, ConfirmDialog, FilePicker, Icon } from "../../../dashboard/ui";
import type { ModulePanelProperties } from "../../contract";
import type { MediaAssetMetadata } from "../contracts";
import { overlayAlertsPanelTexts } from "./locale";
import { deleteMediaAsset, loadMediaAssets, mediaAssetUrl, uploadMediaAsset } from "./service";
import "./panel.css";

type Language = "de" | "en";

const mediaErrorMessage = (error: unknown, language: Language): string => {
  const labels = overlayAlertsPanelTexts[language];
  if (!(error instanceof PanelApiError)) return labels.uploadFailed;
  if (error.code === "media_too_large") return labels.tooLarge;
  if (error.code === "media_type_invalid") return labels.wrongType;
  if (error.code === "media_limit_reached") return labels.limitReached;
  if (error.code === "media_in_use") return labels.mediaInUse;
  return labels.uploadFailed;
};

const formatBytes = (bytes: number, language: Language): string => {
  const locale = language === "de" ? "de-DE" : "en-US";
  const format = (value: number, unit: string, digits: number): string =>
    `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${unit}`;
  if (bytes < 1024) return format(bytes, "B", 0);
  if (bytes < 1024 * 1024) return format(bytes / 1024, "KB", 0);
  return format(bytes / (1024 * 1024), "MB", 1);
};

const formatDate = (asset: MediaAssetMetadata, language: Language): string =>
  overlayAlertsPanelTexts[language].typeAndSize(
    asset.kind === "image" ? overlayAlertsPanelTexts[language].image : overlayAlertsPanelTexts[language].sound,
    formatBytes(asset.byteSize, language),
  );

function MediaRow({
  asset,
  channelId,
  language,
  canManage,
  playingId,
  setPlayingId,
  onDelete,
}: {
  asset: MediaAssetMetadata;
  channelId: string;
  language: Language;
  canManage: boolean;
  playingId: string | null;
  setPlayingId: Dispatch<SetStateAction<string | null>>;
  onDelete: (asset: MediaAssetMetadata) => void;
}): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);
  const labels = overlayAlertsPanelTexts[language];
  const isPlaying = playingId === asset.id;
  const url = mediaAssetUrl(channelId, asset);

  // Starting another sound makes this one inactive: stop it and rewind.
  useEffect(() => {
    const audio = audioRef.current;
    if (!isPlaying && audio !== null && !audio.paused) {
      audio.pause();
      audio.currentTime = 0;
    }
  }, [isPlaying]);

  const clearIfActive = (): void => setPlayingId((current) => current === asset.id ? null : current);

  const togglePlayback = (): void => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (isPlaying) {
      audio.pause();
      setPlayingId(null);
      return;
    }
    setPlayingId(asset.id);
    audio.play().catch(clearIfActive);
  };

  return <li className="overlay-alerts-media-row">
    {asset.kind === "image"
      ? <img className="overlay-alerts-media-row__preview" src={url} alt={labels.preview(asset.fileName)} loading="lazy" />
      : <div className="overlay-alerts-media-row__sound" aria-hidden="true"><Icon name="volume-3" size={20} /></div>}
    <div className="overlay-alerts-media-row__details">
      <strong className="overlay-alerts-media-row__name" title={asset.fileName}>{asset.fileName}</strong>
      <span className="overlay-alerts-media-row__metadata">{formatDate(asset, language)}</span>
    </div>
    <div className="overlay-alerts-media-row__actions">
      {asset.kind === "sound" ? <>
        <audio
          ref={audioRef}
          src={url}
          preload="none"
          onEnded={clearIfActive}
          onPause={clearIfActive}
        />
        <Button
          icon={isPlaying ? "player-pause" : "player-play"}
          iconOnly
          ariaLabel={`${isPlaying ? labels.pause : labels.play}: ${asset.fileName}`}
          ariaPressed={isPlaying}
          onClick={togglePlayback}
        />
      </> : null}
      {!canManage ? null : <Button
        icon="remove"
        iconOnly
        danger="subtle"
        ariaLabel={labels.deleteNamed(asset.fileName)}
        onClick={() => onDelete(asset)}
      />}
    </div>
  </li>;
}

export default function OverlayAlertsPanel({ channelId, language = "de", canManage = false }: ModulePanelProperties): ReactElement {
  const lang: Language = language === "en" ? "en" : "de";
  const labels = overlayAlertsPanelTexts[lang];
  const query = useModuleQuery(channelId, "overlay_alerts", "data", (signal) => loadMediaAssets(channelId, signal));
  const queryClient = useDashboardQueryClient();
  const writeMedia = <Value,>(
    write: () => Promise<Value>,
    updateList: (assets: MediaAssetMetadata[], result: Value) => MediaAssetMetadata[],
  ): Promise<Value> => runModuleQueryWrite(queryClient, channelId, "overlay_alerts", "data", write, {
    baselineRevision: null,
    updateCache: (current, result) => updateList(Array.isArray(current) ? current as MediaAssetMetadata[] : [], result),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MediaAssetMetadata | null>(null);

  const upload = async (file: File | undefined): Promise<void> => {
    if (file === undefined || !canManage || pending) return;
    setPending(true);
    setStatus("");
    try {
      await writeMedia(
        () => uploadMediaAsset(channelId, file),
        (assets, created) => [created, ...assets.filter((asset) => asset.id !== created.id)],
      );
      setStatus(labels.uploadSuccess);
    } catch (error) {
      setStatus(mediaErrorMessage(error, lang));
    } finally {
      setPending(false);
      if (fileInput.current !== null) fileInput.current.value = "";
    }
  };

  const deleteAsset = async (): Promise<void> => {
    if (confirming === null || pending) return;
    setPending(true);
    setStatus("");
    try {
      const { id } = confirming;
      await writeMedia(() => deleteMediaAsset(channelId, id), (assets) => assets.filter((asset) => asset.id !== id));
      setConfirming(null);
      setStatus(labels.deleteSuccess);
    } catch (error) {
      setStatus(error instanceof PanelApiError && error.code === "media_in_use" ? labels.mediaInUse : labels.deleteFailed);
      setConfirming(null);
    } finally {
      setPending(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>): void => {
    event.preventDefault();
    setDragging(false);
    if (canManage) void upload(event.dataTransfer.files[0]);
  };

  const assets = query.data ?? [];
  return <div className="module-stack overlay-alerts-panel">
    <section className="overlay-alerts-media" aria-labelledby="overlay-alerts-media-heading">
      <div className="overlay-alerts-media__heading">
        <div>
          <h2 id="overlay-alerts-media-heading">{labels.heading}</h2>
        </div>
        {canManage ? <Button
          variant="primary"
          icon="add"
          disabled={pending}
          onClick={() => fileInput.current?.click()}
        >{labels.upload}</Button> : null}
      </div>

      {canManage ? <label
        className={`overlay-alerts-drop-zone${dragging ? " is-dragging" : ""}`}
        onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={handleDrop}
      >
        <FilePicker
          ref={fileInput}
          className="overlay-alerts-drop-zone__input"
          accept="image/png,image/gif,image/webp,audio/mpeg,audio/ogg,audio/wav"
          ariaLabel={labels.chooseFile}
          disabled={pending}
          onChange={(file) => { void upload(file); }}
        />
        <span className="overlay-alerts-drop-zone__icon"><Icon name="add" size={20} /></span>
        <span className="overlay-alerts-drop-zone__copy">
          <strong>{labels.dropTitle}</strong>
          <span>{labels.dropHint}</span>
        </span>
      </label> : null}

      <div className="overlay-alerts-media__status" role={status.length > 0 || query.isError ? "alert" : "status"} aria-live="polite">
        {query.isError ? labels.loadFailed : status || "\u00a0"}
      </div>

      {query.isPending && assets.length === 0
        ? <div className="overlay-alerts-media__state" role="status">{labels.loading}</div>
        : assets.length === 0
          ? <div className="overlay-alerts-media__empty">
            <h3>{labels.emptyTitle}</h3>
            <p>{labels.emptyDescription}</p>
          </div>
          : <ul className="overlay-alerts-media__list">
            {assets.map((asset) => <MediaRow
              key={asset.id}
              asset={asset}
              channelId={channelId}
              language={lang}
              canManage={canManage}
              playingId={playingId}
              setPlayingId={setPlayingId}
              onDelete={setConfirming}
            />)}
          </ul>}
    </section>

    <ConfirmDialog
      opened={confirming !== null}
      title={labels.deleteTitle}
      description={labels.deleteDescription(confirming?.fileName ?? "")}
      confirmLabel={labels.delete}
      cancelLabel={labels.cancel}
      danger
      pending={pending}
      onCancel={() => setConfirming(null)}
      onConfirm={() => { void deleteAsset(); }}
    />
  </div>;
}
