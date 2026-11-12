import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { DEFAULT_OVERLAY_ALERT_CONFIG, parseOverlayAlertConfig, parseOverlayAlertQueueState } from "./state";

import "./view.css";

const useAuthorizedMediaUrl = (path: string | undefined, token: string | undefined): string | null => {
  const [mediaUrl, setMediaUrl] = useState<{ path: string; token: string; objectUrl: string } | null>(null);
  useEffect(() => {
    if (path === undefined || token === undefined) return;
    const controller = new AbortController();
    let disposed = false;
    let nextObjectUrl: string | null = null;
    void fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("Overlay media request failed.");
      return await response.blob();
    }).then((blob) => {
      if (disposed) return;
      nextObjectUrl = URL.createObjectURL(blob);
      setMediaUrl({ path, token, objectUrl: nextObjectUrl });
    }).catch(() => {
      // Missing media is cosmetic; the text and remaining visual stay available.
    });
    return () => {
      disposed = true;
      controller.abort();
      if (nextObjectUrl !== null) URL.revokeObjectURL(nextObjectUrl);
    };
  }, [path, token]);
  return mediaUrl !== null && mediaUrl.path === path && mediaUrl.token === token ? mediaUrl.objectUrl : null;
};

const OverlayAlert = ({ config: rawConfig, state: rawState, now, mediaAccessToken }: ModuleOverlayElementProps): ReactElement | null => {
  const state = useMemo(() => parseOverlayAlertQueueState(rawState), [rawState]);
  const current = state?.current ?? null;
  const currentOperationId = current?.operationId;
  const currentVolumePercent = current?.volumePercent;
  const config = parseOverlayAlertConfig(rawConfig) ?? DEFAULT_OVERLAY_ALERT_CONFIG;
  const audioRef = useRef<HTMLAudioElement>(null);
  const serverNow = state === null ? Number.NaN : Date.parse(state.serverNow);
  const [clock, setClock] = useState(() => ({
    serverNow,
    currentTime: Number.isFinite(serverNow) ? serverNow : now,
  }));

  useEffect(() => {
    if (currentOperationId === undefined) return;
    const offset = serverNow - performance.now();
    const timer = window.setInterval(() => {
      const currentTime = performance.now() + offset;
      setClock({ serverNow, currentTime });
    }, 100);
    return () => window.clearInterval(timer);
  }, [currentOperationId, serverNow]);

  const currentTime = clock.serverNow === serverNow ? clock.currentTime : Number.isFinite(serverNow) ? serverNow : now;
  const isActive = current !== null && Date.parse(current.endsAt) > currentTime;
  const imageUrl = useAuthorizedMediaUrl(current?.imageUrl, mediaAccessToken);
  const soundUrl = useAuthorizedMediaUrl(current?.soundUrl, mediaAccessToken);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null || currentVolumePercent === undefined || !isActive || soundUrl === null) return;
    try {
      audio.volume = currentVolumePercent / 100;
      void audio.play().catch(() => {
        // OBS may block autoplay; the visual alert stays visible without sound.
      });
    } catch {
      // A browser media implementation may reject playback before returning a promise.
    }
    return () => {
      audio.pause();
      audio.currentTime = 0;
    };
  }, [currentOperationId, currentVolumePercent, isActive, soundUrl]);

  if (current === null || !isActive) return null;
  const style = {
    "--overlay-alert-text-color": config.textColor,
    "--overlay-alert-font-size": `${String(config.fontSize)}px`,
  } as CSSProperties;

  return <section className="overlay-alert" data-alert-id={current.operationId} style={style} role="status" aria-live="polite">
    {imageUrl === null ? null : <img className="overlay-alert__image" src={imageUrl} alt="" />}
    {current.text.length === 0 ? null : <p className="overlay-alert__text">{current.text}</p>}
    {soundUrl === null ? null : <audio ref={audioRef} src={soundUrl} preload="auto" />}
  </section>;
};

export default OverlayAlert;
