import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import "./overlay-marquee.css";

export interface OverlayMarqueeProps {
  text: string;
  className?: string;
  title?: string;
  /** Seconds to rest at either end. */
  holdSeconds?: number;
  /** Scroll speed in layout px per second. */
  speed?: number;
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;

/**
 * One line of text. A line that fits is static; a line that overflows rests, scrolls to its end at a
 * constant speed, rests again and scrolls back, forever. Reduced motion keeps the static ellipsis.
 * The motion is a CSS animation whose keyframes are derived once per size change, so there is no
 * per-frame script.
 */
export const OverlayMarquee = ({ text, className, title, holdSeconds = 2, speed = 40 }: OverlayMarqueeProps): ReactElement => {
  const boxRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const animationName = `overlay-marquee-${useId().replaceAll(/[^a-zA-Z0-9_-]/gu, "")}`;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const content = textRef.current;
    if (box === null || content === null) return;
    const measure = (): void => {
      // Overflow beyond one pixel is a real overflow; fractional widths must not start a scroll.
      const overflow = content.scrollWidth - box.clientWidth;
      setDistance(overflow > 1 ? Math.ceil(overflow) : 0);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(box);
    observer?.observe(content);
    // A font swap changes the text width without resizing the box.
    const fonts = typeof document === "undefined" ? undefined : document.fonts;
    fonts?.addEventListener("loadingdone", measure);
    return () => {
      observer?.disconnect();
      fonts?.removeEventListener("loadingdone", measure);
    };
  }, [text]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION);
    const update = (): void => { setReduced(query.matches); };
    update();
    query.addEventListener("change", update);
    return () => { query.removeEventListener("change", update); };
  }, []);

  const scrolling = distance > 0 && !reduced;
  const travelSeconds = distance / speed;
  const cycleSeconds = 2 * (holdSeconds + travelSeconds);
  const holdPercent = (holdSeconds / cycleSeconds) * 100;
  const style = scrolling
    ? {
      "--overlay-marquee-distance": `${String(distance)}px`,
      "--overlay-marquee-duration": `${cycleSeconds.toFixed(2)}s`,
      animationName,
    } as CSSProperties
    : undefined;

  return <>
    {scrolling
      ? <style>{`@keyframes ${animationName}{0%,${holdPercent.toFixed(3)}%{transform:translateX(0)}50%,${(50 + holdPercent).toFixed(3)}%{transform:translateX(calc(-1 * var(--overlay-marquee-distance)))}100%{transform:translateX(0)}}`}</style>
      : null}
    <span ref={boxRef} className={["overlay-marquee", className].filter(Boolean).join(" ")} title={title ?? text}>
      <span ref={textRef} className="overlay-marquee__text" data-scrolling={scrolling ? "true" : "false"} style={style}>{text}</span>
    </span>
  </>;
};
