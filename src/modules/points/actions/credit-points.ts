import { z } from "zod";

import type { ChannelPointsActionDefinition, ModuleExecutionContext } from "../../contract";
import { POINTS_MODULE_ID, isPointViewerAccountId, pointsSettingsReadSchema } from "../contracts";
import { pointsCatalog } from "../locale";

export const creditPointsConfigSchema = z.object({
  amount: z.number().int().min(1).max(1_000_000),
});

const refund = (reason: "disabled" | "rejected") => ({
  refund: {
    de: pointsCatalog.de.channelPointsActions[reason],
    en: pointsCatalog.en.channelPointsActions[reason],
  },
});

const isCreditOperation = (operation: { kind: string; result: unknown } | null): boolean => {
  if (operation === null || operation.kind !== "bonus" || typeof operation.result !== "object" ||
      operation.result === null || Array.isArray(operation.result)) return false;
  const amount: unknown = Reflect.get(operation.result, "amount");
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 1 && amount <= 1_000_000;
};

export const creditPointsAction: ChannelPointsActionDefinition<typeof creditPointsConfigSchema> = {
  id: "credit-points",
  name: {
    de: pointsCatalog.de.channelPointsActions.name,
    en: pointsCatalog.en.channelPointsActions.name,
  },
  configSchema: creditPointsConfigSchema,
  editor: () => import("./credit-points-editor"),
  execute: async (context, { redemption, config, operationId }) => {
    const parsedConfig = creditPointsConfigSchema.safeParse(config);
    if (!parsedConfig.success || !isPointViewerAccountId(redemption.userId) || redemption.userLogin.length === 0) {
      return refund("rejected");
    }
    if (context.channelId === undefined) return refund("disabled");

    try {
      const module = await context.DB.prepare(
        "SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = ?",
      ).bind(context.channelId, POINTS_MODULE_ID).first<{ enabled: number; settings: string }>();
      if (module?.enabled !== 1) return refund("disabled");
      const existingOperation = await context.points.getOperation(`channel-points:credit-points:${operationId}`);
      if (existingOperation !== null) return isCreditOperation(existingOperation) ? "fulfilled" : "pending";

      const settings = pointsSettingsReadSchema.parse(JSON.parse(module.settings) as unknown);
      await context.points.touchAccount(redemption.userId, redemption.userLogin, settings.startBonus);
    } catch {
      return "pending";
    }

    const ledgerOperationId = `channel-points:credit-points:${operationId}`;
    const amount = parsedConfig.data.amount;
    try {
      await context.points.apply(ledgerOperationId, "bonus", [
        { accountId: redemption.userId, delta: amount, login: redemption.userLogin },
        { accountId: "__house", delta: -amount },
      ], { amount }, {
        actionId: "credit-points",
        redemptionId: operationId,
        accountId: redemption.userId,
        login: redemption.userLogin,
        amount,
      });
      return "fulfilled";
    } catch (error) {
      let existingOperation: Awaited<ReturnType<ModuleExecutionContext["points"]["getOperation"]>>;
      try {
        existingOperation = await context.points.getOperation(ledgerOperationId);
      } catch {
        return "pending";
      }
      if (existingOperation !== null) return isCreditOperation(existingOperation) ? "fulfilled" : "pending";
      if (error instanceof Error && error.message === "operation_conflict") return "pending";
      return refund("rejected");
    }
  },
};
