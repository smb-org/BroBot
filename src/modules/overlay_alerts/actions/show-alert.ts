import { z } from "zod";

import type { ChannelPointsActionDefinition } from "../../contract";
import { findMediaAsset } from "../repository";
import { renderOverlayAlertText } from "../overlay/state";
import { overlayAlertsActionTexts } from "../locale";

export const showAlertConfigSchema = z.object({
  imageAssetId: z.string().trim().min(1).max(128).optional(),
  soundAssetId: z.string().trim().min(1).max(128).optional(),
  text: z.string().max(200).default("{user} · {reward}"),
  durationSeconds: z.number().int().min(2).max(15).default(5),
  volumePercent: z.number().int().min(0).max(100).default(80),
}).strict().superRefine((config, context) => {
  if (config.imageAssetId === undefined && config.soundAssetId === undefined && config.text.trim().length === 0) {
    context.addIssue({ code: "custom", path: ["text"], message: "An image, sound, or text is required." });
  }
});

const refund = (reason: "invalidConfig" | "overlayNotConnected") => ({
  refund: {
    de: overlayAlertsActionTexts.de[reason],
    en: overlayAlertsActionTexts.en[reason],
  },
});

const mediaPath = (id: string, sha256: string): string =>
  `/api/overlay/media/${encodeURIComponent(id)}/${encodeURIComponent(sha256)}`;

export const showAlertAction: ChannelPointsActionDefinition<typeof showAlertConfigSchema> = {
  id: "show-alert",
  name: {
    de: overlayAlertsActionTexts.de.name,
    en: overlayAlertsActionTexts.en.name,
  },
  configSchema: showAlertConfigSchema,
  editor: () => import("../panel/show-alert-editor"),
  execute: async (context, { redemption, config, operationId }) => {
    const parsed = showAlertConfigSchema.safeParse(config);
    if (!parsed.success || context.channelId === undefined) return refund("invalidConfig");
    const { imageAssetId, soundAssetId, text, durationSeconds, volumePercent } = parsed.data;

    let image: Awaited<ReturnType<typeof findMediaAsset>> | null;
    let sound: Awaited<ReturnType<typeof findMediaAsset>> | null;
    try {
      [image, sound] = await Promise.all([
        imageAssetId === undefined ? Promise.resolve(null) : findMediaAsset(context.DB, context.channelId, imageAssetId),
        soundAssetId === undefined ? Promise.resolve(null) : findMediaAsset(context.DB, context.channelId, soundAssetId),
      ]);
    } catch {
      return "pending";
    }
    if ((imageAssetId !== undefined && image?.kind !== "image") ||
        (soundAssetId !== undefined && sound?.kind !== "sound")) return refund("invalidConfig");

    const enqueue = context.overlayAlertQueue?.enqueue;
    if (enqueue === undefined) return "pending";
    const renderedText = renderOverlayAlertText(text, {
      userName: redemption.userName,
      userLogin: redemption.userLogin,
      userInput: redemption.userInput,
      rewardTitle: redemption.rewardTitle,
    });
    try {
      const outcome = await enqueue(operationId, {
        ...(image === null ? {} : { imageUrl: mediaPath(image.id, image.sha256) }),
        ...(sound === null ? {} : { soundUrl: mediaPath(sound.id, sound.sha256) }),
        text: renderedText,
        durationSeconds,
        volumePercent,
      });
      return outcome === "not_connected" ? refund("overlayNotConnected") : "fulfilled";
    } catch {
      return "pending";
    }
  },
};
