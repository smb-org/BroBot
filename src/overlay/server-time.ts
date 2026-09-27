import type { OverlayBootstrapData } from "./model";

/**
 * `serverNow` is stamped right before the response is sent, after all server-side
 * processing, so only the response's one-way network leg is still unaccounted for.
 * The round trip mixes that leg with request transit and server processing time, so
 * halving it overestimates transit whenever the server is slow. Bound the correction
 * instead of deriving it from the round trip.
 * ponytail: fixed cap, not a measured one-way estimate; revisit if precise sync matters.
 */
const MAX_ESTIMATED_TRANSIT_MS = 50;

export const estimateOverlayStateTransit = (
  bootstrap: OverlayBootstrapData,
  roundTripMs: number,
): OverlayBootstrapData => {
  if (bootstrap.overlay === null || !Number.isFinite(roundTripMs)) return bootstrap;
  const estimatedTransitMs = Math.min(Math.max(0, roundTripMs) / 2, MAX_ESTIMATED_TRANSIT_MS);
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
