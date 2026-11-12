import { z } from "zod";

import type { ChannelPointsActionDefinition, ModuleTempVipResult } from "../../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS, TEMP_VIPS_MODULE_ID, tempVipsSettingsSchema } from "../contracts";
import { tempVipsChannelPointsActionTexts } from "../locale";

const DAY_MS = 24 * 60 * 60_000;

export const grantVipConfigSchema = z.object({
  durationDays: z.number().int().min(1).max(90).default(DEFAULT_TEMP_VIPS_SETTINGS.defaultDurationDays),
});

type RefundReason = keyof typeof tempVipsChannelPointsActionTexts.en.refundReasons;

const refund = (reason: RefundReason) => ({
  refund: {
    de: tempVipsChannelPointsActionTexts.de.refundReasons[reason],
    en: tempVipsChannelPointsActionTexts.en.refundReasons[reason],
  },
});

const retryableReasons = new Set(["network", "rate_limited", "not_connected", "token_unavailable", "revoked", "refresh_failed"]);

const mapResult = (result: ModuleTempVipResult) => {
  if (result.status === "granted" || result.status === "extended") return "fulfilled" as const;
  if (result.status === "queued" || result.status === "busy") return "pending" as const;
  if (result.status === "module_disabled") return refund("moduleDisabled");
  if (result.status === "maximum_exceeded") return refund("maximumExceeded");
  if (result.status === "permanent_vip" || result.status === "unclassified_vip" ||
      result.status === "already_vip" || result.status === "already_managed") return refund("alreadyVip");

  const reason = result.reason;
  if (result.status === "twitch_unavailable" && retryableReasons.has(reason ?? "")) return "pending" as const;
  if (reason === "no_slots") return refund("noSlots");
  if (reason === "moderator") return refund("moderator");
  if (reason === "community_gate") return refund("communityGate");
  if (reason === "scope_missing") return refund("scopeMissing");
  if (reason === "already_vip") return refund("alreadyVip");
  if (reason === "user_not_found") return refund("userNotFound");
  if (reason === "broadcaster_required") return refund("broadcasterRequired");
  return refund("rejected");
};

export const grantVipAction: ChannelPointsActionDefinition<typeof grantVipConfigSchema> = {
  id: "grant-vip",
  name: {
    de: tempVipsChannelPointsActionTexts.de.name,
    en: tempVipsChannelPointsActionTexts.en.name,
  },
  configSchema: grantVipConfigSchema,
  editor: () => import("./grant-vip-editor"),
  execute: async (context, { redemption, config, operationId }) => {
    if (context.channelId === undefined || redemption.userId.length === 0) return refund("invalidConfiguration");

    try {
      const existing = await context.tempVips.replayGrant(operationId, redemption.userId);
      if (existing !== null) return mapResult(existing);
    } catch {
      // The journal may be temporarily unavailable; the grant outcome must remain retryable.
      return "pending";
    }

    const parsedConfig = grantVipConfigSchema.safeParse(config);
    if (!parsedConfig.success || redemption.userLogin.length === 0) return refund("invalidConfiguration");
    if (redemption.userId === context.channelId) return refund("broadcaster");

    let module: { enabled: number; settings: string } | null;
    try {
      module = await context.DB.prepare(
        "SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = ?",
      ).bind(context.channelId, TEMP_VIPS_MODULE_ID).first<{ enabled: number; settings: string }>();
    } catch {
      return "pending";
    }
    if (module?.enabled !== 1) return refund("moduleDisabled");

    let settings: ReturnType<typeof tempVipsSettingsSchema.parse>;
    try {
      settings = tempVipsSettingsSchema.parse(JSON.parse(module.settings) as unknown);
    } catch {
      return refund("invalidConfiguration");
    }
    const { durationDays } = parsedConfig.data;
    if (durationDays > settings.maximumDurationDays) return refund("maximumExceeded");

    try {
      const mode = await context.tempVips.mode();
      if (mode === "inactive") return refund("moduleDisabled");
      if (mode === "observe") return refund("scopeMissing");
      const result = await context.tempVips.grant({
        operationId,
        person: {
          userId: redemption.userId,
          login: redemption.userLogin,
          displayName: redemption.userName.length > 0 ? redemption.userName : redemption.userLogin,
        },
        // Channel-points grants are automated, so their durable audit actor is the system.
        grantedBy: null,
        durationMs: durationDays * DAY_MS,
        maximumRemainingMs: settings.maximumDurationDays * DAY_MS,
        source: "channel_points",
      });
      return mapResult(result);
    } catch {
      return "pending";
    }
  },
};
