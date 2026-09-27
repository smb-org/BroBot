import type { OverlayBootstrapData } from "./model";

export const estimateOverlayStateTransit = (
  bootstrap: OverlayBootstrapData,
  roundTripMs: number,
): OverlayBootstrapData => {
  if (bootstrap.overlay === null || !Number.isFinite(roundTripMs)) return bootstrap;
  const estimatedTransitMs = Math.max(0, roundTripMs) / 2;
  return {
    ...bootstrap,
    overlay: {
      ...bootstrap.overlay,
      elements: bootstrap.overlay.elements.map((element) => {
        const state = element.state;
        const serverNow = state?.serverNow;
        if (typeof serverNow !== "string" || !Number.isFinite(Date.parse(serverNow))) return element;
        return { ...element, state: { ...state, serverNow: new Date(Date.parse(serverNow) + estimatedTransitMs).toISOString() } };
      }),
    },
  };
};
