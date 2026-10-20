import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { emoteSlotOverlayLabels } from "./locale";
import { DEFAULT_SLOT_OVERLAY_CONFIG, isSlotOverlayState, parseSlotOverlayConfig, SLOT_OVERLAY_EDITOR_PREVIEW_SPIN_ID } from "./state";
import type { SlotOverlaySymbol } from "./state";

import "./slot.css";

const formatNumber = (value: number, language: "de" | "en"): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US").format(value);

const formatNet = (value: number, language: "de" | "en"): string => value === 0
  ? "±0"
  : `${value > 0 ? "+" : "−"}${formatNumber(Math.abs(value), language)}`;

const useReducedMotion = (): boolean => {
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reducedMotion;
};

const emoteImageUrl = (symbol: SlotOverlaySymbol): string | null => {
  if (symbol.source === "twitch" && symbol.twitchId !== undefined) {
    return `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(symbol.twitchId)}/default/dark/2.0`;
  }
  if (symbol.source === "seven_tv" && symbol.sevenTvId !== undefined && symbol.missing !== true) {
    return `https://cdn.7tv.app/emote/${encodeURIComponent(symbol.sevenTvId)}/2x.webp`;
  }
  return null;
};

const SLOT_REEL_ANIMATION_END_MS = 1_200;
const SLOT_JACKPOT_HIGHLIGHT_END_MS = 3_000;
const SLOT_RESULT_VISIBLE_MS = 6_000;

interface SlotPresentation {
  startedAt: number;
  deadline: number;
  expirationTimer: number | null;
}

interface SlotPresentationSnapshot {
  presentation: SlotPresentation;
  elapsed: number;
}

const presentations = new Map<string, SlotPresentation>();
const expiredSpinKeys = new Set<string>();
const activeSpinIdsByElement = new Map<string, string>();

const presentationKey = (elementId: string, spinId: string): string => JSON.stringify([elementId, spinId]);

const clearPresentationFor = (elementId: string, spinId: string): void => {
  const key = presentationKey(elementId, spinId);
  const presentation = presentations.get(key);
  if (presentation?.expirationTimer !== null && presentation?.expirationTimer !== undefined && typeof window !== "undefined") {
    window.clearTimeout(presentation.expirationTimer);
  }
  presentations.delete(key);
  expiredSpinKeys.delete(key);
};

const expirePresentation = (elementId: string, spinId: string): void => {
  const key = presentationKey(elementId, spinId);
  const presentation = presentations.get(key);
  if (presentation?.expirationTimer !== null && presentation?.expirationTimer !== undefined && typeof window !== "undefined") {
    window.clearTimeout(presentation.expirationTimer);
  }
  presentations.delete(key);
  expiredSpinKeys.add(key);
};

const snapshotPresentation = (presentation: SlotPresentation): SlotPresentationSnapshot => ({
  presentation,
  elapsed: Math.max(0, Date.now() - presentation.startedAt),
});

const getPresentation = (elementId: string, spinId: string, duration: number): SlotPresentationSnapshot | null => {
  const activeSpinId = activeSpinIdsByElement.get(elementId);
  if (activeSpinId !== undefined && activeSpinId !== spinId) clearPresentationFor(elementId, activeSpinId);
  activeSpinIdsByElement.set(elementId, spinId);

  const key = presentationKey(elementId, spinId);
  if (expiredSpinKeys.has(key)) return null;
  const existing = presentations.get(key);
  if (existing !== undefined) {
    if (existing.deadline <= Date.now()) {
      expirePresentation(elementId, spinId);
      return null;
    }
    return snapshotPresentation(existing);
  }

  const startedAt = Date.now();
  const deadline = startedAt + duration;
  const expirationTimer = typeof window === "undefined" ? null : window.setTimeout(() => {
    expirePresentation(elementId, spinId);
  }, duration);
  const presentation = { startedAt, deadline, expirationTimer };
  presentations.set(key, presentation);
  return snapshotPresentation(presentation);
};

const ReelSymbol = ({ symbol, index }: { symbol: SlotOverlaySymbol; index: number }): ReactElement => {
  const [imageFailed, setImageFailed] = useState(false);
  const src = imageFailed ? null : emoteImageUrl(symbol);
  const codeFallback = src === null && symbol.source !== "emoji";
  return <span className={`emote-slot-overlay__reel${codeFallback ? " emote-slot-overlay__reel--code" : ""}`} data-testid="emote-slot-reel" data-reel-index={index}>
    {src === null ? <span className={codeFallback ? "emote-slot-overlay__code" : "emote-slot-overlay__glyph"} title={symbol.code}>{symbol.code}</span> :
      <img src={src} alt="" onError={() => { setImageFailed(true); }} />}
  </span>;
};

const SlotOverlay = ({ config, state, elementId = "standalone-slot" }: ModuleOverlayElementProps): ReactElement | null => {
  const reducedMotion = useReducedMotion();
  const [expiredSpinId, setExpiredSpinId] = useState<string | null>(null);
  const overlayConfig = parseSlotOverlayConfig(config) ?? DEFAULT_SLOT_OVERLAY_CONFIG;
  const validState = state !== null && isSlotOverlayState(state) ? state : null;
  const language = validState?.language ?? "de";
  const labels = emoteSlotOverlayLabels(language);
  const spinId = validState?.spinId;
  const isEditorPreview = spinId === SLOT_OVERLAY_EDITOR_PREVIEW_SPIN_ID;
  const presentationSnapshot = spinId === undefined || isEditorPreview
    ? null
    : getPresentation(elementId, spinId, (reducedMotion ? 0 : SLOT_REEL_ANIMATION_END_MS) + SLOT_RESULT_VISIBLE_MS);
  const presentation = presentationSnapshot?.presentation ?? null;
  const presentationElapsed = presentationSnapshot?.elapsed ?? 0;
  const reelAnimationRunning = !reducedMotion && presentationElapsed < SLOT_REEL_ANIMATION_END_MS;
  const jackpotHighlightRunning = !reducedMotion && validState?.jackpotHit === true && presentationElapsed < SLOT_JACKPOT_HIGHLIGHT_END_MS;

  useEffect(() => {
    if (spinId === undefined || spinId === SLOT_OVERLAY_EDITOR_PREVIEW_SPIN_ID) return;
    if (presentation === null) return;
    const remainingDuration = Math.max(0, presentation.deadline - Date.now());
    const timer = window.setTimeout(() => {
      expirePresentation(elementId, spinId);
      setExpiredSpinId(spinId);
    }, remainingDuration);
    return () => { window.clearTimeout(timer); };
  }, [elementId, presentation, spinId]);

  if (validState === null || (!isEditorPreview && (presentation === null || expiredSpinId === validState.spinId))) return null;

  const style = {
    "--content-game-reel-background": overlayConfig.backgroundColor,
    "--content-game-reel-text": overlayConfig.textColor,
    "--content-game-reel-secondary": overlayConfig.secondaryColor,
    "--content-game-reel-highlight": overlayConfig.highlightColor,
    "--content-game-reel-border": overlayConfig.borderColor,
    "--slot-presentation-elapsed": `${String(presentationElapsed)}ms`,
  } as CSSProperties;

  return <section className={`emote-slot-overlay${validState.jackpotHit ? " emote-slot-overlay--jackpot" : ""}`}
    style={style} role="group" aria-label={labels.result} data-testid="emote-slot-overlay"
    data-reel-animation-running={String(reelAnimationRunning)} data-jackpot-animation-running={String(jackpotHighlightRunning)}
    data-spin-id={validState.spinId} data-reduced-motion={String(reducedMotion)}>
    <div className="emote-slot-overlay__spin">
    <div className="emote-slot-overlay__reels" aria-label={validState.symbols.map(({ code }) => code).join(" ")}>
      {validState.symbols.map((symbol, index) => <ReelSymbol key={`${validState.spinId}-${String(index)}`} symbol={symbol} index={index} />)}
    </div>
    <div className="emote-slot-overlay__result">
      <div className="emote-slot-overlay__values">
        <strong className="emote-slot-overlay__login" title={validState.login}>{validState.login}</strong>
        <strong className="emote-slot-overlay__main">{formatNet(validState.net, language)}</strong>
      </div>
      <span className="emote-slot-overlay__secondary emote-slot-overlay__outcome">{labels.outcomes[validState.outcome]}</span>
    </div>
    </div>
    <div className="emote-slot-overlay__jackpot">
      <span className="emote-slot-overlay__secondary">{labels.jackpot}</span>
      <strong key={validState.spinId} className="emote-slot-overlay__main">{formatNumber(validState.jackpot, language)}</strong>
    </div>
  </section>;
};

export default SlotOverlay;
