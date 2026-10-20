import { useEffect, useState, type CSSProperties, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { emoteSlotOverlayLabels } from "./locale";
import { DEFAULT_SLOT_OVERLAY_CONFIG, isSlotOverlayState, parseSlotOverlayConfig } from "./state";
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

const ReelSymbol = ({ symbol, index }: { symbol: SlotOverlaySymbol; index: number }): ReactElement => {
  const [imageFailed, setImageFailed] = useState(false);
  const src = imageFailed ? null : emoteImageUrl(symbol);
  const codeFallback = src === null && symbol.source !== "emoji";
  return <span className={`emote-slot-overlay__reel${codeFallback ? " emote-slot-overlay__reel--code" : ""}`} data-testid="emote-slot-reel" data-reel-index={index}>
    {src === null ? <span className={codeFallback ? "emote-slot-overlay__code" : "emote-slot-overlay__glyph"} title={symbol.code}>{symbol.code}</span> :
      <img src={src} alt="" onError={() => { setImageFailed(true); }} />}
  </span>;
};

const SlotOverlay = ({ config, state }: ModuleOverlayElementProps): ReactElement | null => {
  const reducedMotion = useReducedMotion();
  const [expiredSpinId, setExpiredSpinId] = useState<string | null>(null);
  const overlayConfig = parseSlotOverlayConfig(config) ?? DEFAULT_SLOT_OVERLAY_CONFIG;
  const validState = state !== null && isSlotOverlayState(state) ? state : null;
  const language = validState?.language ?? "de";
  const labels = emoteSlotOverlayLabels(language);
  const spinId = validState?.spinId;
  const spunAt = validState?.spunAt;

  useEffect(() => {
    if (spinId === undefined || spunAt === undefined) return;
    const expiresAt = Date.parse(spunAt) + 6_000;
    const remaining = Math.max(0, expiresAt - Date.now());
    const timer = window.setTimeout(() => { setExpiredSpinId(spinId); }, remaining);
    return () => { window.clearTimeout(timer); };
  }, [spinId, spunAt]);

  if (validState === null || expiredSpinId === validState.spinId) return null;

  const style = {
    "--content-game-reel-background": overlayConfig.backgroundColor,
    "--content-game-reel-text": overlayConfig.textColor,
    "--content-game-reel-secondary": overlayConfig.secondaryColor,
    "--content-game-reel-highlight": overlayConfig.highlightColor,
    "--content-game-reel-border": overlayConfig.borderColor,
  } as CSSProperties;

  return <section className={`emote-slot-overlay${validState.jackpotHit ? " emote-slot-overlay--jackpot" : ""}`}
    style={style} role="group" aria-label={labels.result} data-testid="emote-slot-overlay"
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
      <strong className="emote-slot-overlay__main">{formatNumber(validState.jackpot, language)}</strong>
    </div>
  </section>;
};

export default SlotOverlay;
