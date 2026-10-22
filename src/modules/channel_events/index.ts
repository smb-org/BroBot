import { z } from "zod";

import type { EventSubSubscriptionType } from "../../contracts/values";
import type { BotModule, ModuleImmediateActionCondition } from "../contract";
import { channelEventsModuleCatalog } from "./catalog";
import { processChannelEvent } from "./service";
import { streamMarkerActionTexts } from "./panel/quick-action-locale";

const settingsSchema = z.object({});
const eventSubTypes = [
  "channel.raid",
  "channel.shoutout.create",
  "channel.shoutout.receive",
  "channel.chat.notification",
  "channel.moderate",
  "automod.message.hold",
  "channel.suspicious_user.message",
  "channel.suspicious_user.update",
  "stream.online",
  "stream.offline",
] as const satisfies readonly EventSubSubscriptionType[];

const streamMarkerGrantHref = (channelId: string): string =>
  `/auth/channels/${encodeURIComponent(channelId)}/broadcaster-scopes/broadcast`;

const streamMarkerScopeCondition: ModuleImmediateActionCondition = {
  check: async ({ channelId, viewerUserId, signal }) => {
    const { fetchStreamMarkerAvailability } = await import("../../dashboard/api");
    try {
      const availability = await fetchStreamMarkerAvailability(channelId, signal);
      return availability.manageScopeAvailable
        ? { reason: null }
        : viewerUserId === channelId ? {
          reason: streamMarkerActionTexts.scopeMissing,
          link: { href: streamMarkerGrantHref(channelId), label: streamMarkerActionTexts.scopeGrant },
        } : { reason: streamMarkerActionTexts.scopeOwnerOnly };
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      return { reason: streamMarkerActionTexts.scopeCheckFailed };
    }
  },
};

const markerPositionText = (positionSeconds: number): string => {
  const wholeSeconds = Math.floor(positionSeconds);
  return `${String(Math.floor(wholeSeconds / 60))}:${String(wholeSeconds % 60).padStart(2, "0")}`;
};

const streamMarkerAction = async (channelId: string, viewerUserId: string | null | undefined) => {
  const { createStreamMarker } = await import("../../dashboard/api");
  const result = await createStreamMarker(channelId);
  if (result.result === "created") {
    return { message: streamMarkerActionTexts.created(markerPositionText(result.positionSeconds)), tone: "success" as const };
  }
  if (result.result === "scope_missing") {
    return {
      message: (viewerUserId === channelId ? streamMarkerActionTexts.scopeMissing : streamMarkerActionTexts.scopeOwnerOnly),
      tone: "error" as const,
      supersededByAvailability: true,
      ...(viewerUserId === channelId ? { link: { href: result.grantHref, label: streamMarkerActionTexts.scopeGrant } } : {}),
    };
  }
  if (result.result === "not_broadcaster") return { message: streamMarkerActionTexts.notBroadcaster, tone: "error" as const };
  if (result.result === "offline") return { message: streamMarkerActionTexts.offline, tone: "error" as const };
  if (result.result === "rate_limited") {
    return { message: streamMarkerActionTexts.rateLimited(String(result.retryAfter)), tone: "info" as const };
  }
  if (result.result === "token_expired") return { message: streamMarkerActionTexts.tokenExpired, tone: "error" as const };
  return { message: streamMarkerActionTexts.failed, tone: "error" as const };
};

export const channelEventsModule: BotModule<typeof settingsSchema> = {
  id: "channel_events",
  navigationCategory: "admin",
  panelIcon: { paths: ["M5 12h3l2-5 4 10 2-5h3", "M5 19h14"] },
  mandatory: true,
  mandatoryReason: {
    de: channelEventsModuleCatalog.de.mandatoryReason,
    en: channelEventsModuleCatalog.en.mandatoryReason,
  },
  settingsSchema,
  defaultSettings: {},
  eventSubTypes,
  actions: [{
    id: "set-stream-marker",
    name: streamMarkerActionTexts.name,
    icon: "marker",
    conditions: ["streamLive", streamMarkerScopeCondition],
    requiredRole: "manager",
    errorMessage: streamMarkerActionTexts.error,
    execute: async ({ channelId, viewerUserId }) => streamMarkerAction(channelId, viewerUserId),
  }],
  handleEvent: (event) => processChannelEvent(event),
};
