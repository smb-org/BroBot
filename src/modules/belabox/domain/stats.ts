import { z } from "zod";

import type { BelaboxStats } from "../contracts";

const publishersSchema = z.object({ publishers: z.record(z.string(), z.unknown()) });
const relayPublisherSchema = z.object({
  connected: z.boolean(),
  bitrate: z.number().nonnegative(),
  rtt: z.number().nonnegative(),
  latency: z.number().nonnegative(),
  network: z.number().nonnegative(),
  dropped_pkts: z.number().nonnegative(),
});

const disconnectedStats = (): BelaboxStats => ({
  connected: false,
  bitrateKbps: 0,
  rttMs: 0,
  latencyMs: 0,
  network: 0,
  droppedPackets: 0,
});

/** Normalizes only the publisher selected by the validated URL's key segment. */
export const parseRelayStats = (payload: unknown, publisherKey: string): BelaboxStats => {
  const parsedPayload = publishersSchema.safeParse(payload);
  if (!parsedPayload.success) throw new Error("Malformed relay stats.");
  if (!Object.hasOwn(parsedPayload.data.publishers, publisherKey)) return disconnectedStats();

  const parsedPublisher = relayPublisherSchema.safeParse(parsedPayload.data.publishers[publisherKey]);
  if (!parsedPublisher.success) throw new Error("Malformed relay stats.");
  const publisher = parsedPublisher.data;
  return {
    connected: publisher.connected,
    bitrateKbps: publisher.bitrate,
    rttMs: publisher.rtt,
    latencyMs: publisher.latency,
    network: publisher.network,
    droppedPackets: publisher.dropped_pkts,
  };
};
