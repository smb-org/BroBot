import { z } from "zod";

import type { ChannelPointsActionDefinition, ModuleExecutionContext } from "../../contract";
import { POINTS_MODULE_ID, isPointViewerAccountId } from "../contracts";
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

const definitiveLedgerErrors = new Set([
  "account_kind_conflict",
  "balance_overflow",
  "invalid_account",
  "invalid_account_id",
  "invalid_movement",
  "invalid_operation_id",
  "invalid_operation_kind",
  "invalid_pot_share",
  "ledger_not_zero_sum",
  "operation_conflict",
]);

const hasLedgerOperation = async (
  context: ModuleExecutionContext,
  accountId: string,
  operationId: string,
): Promise<boolean> => {
  const history = await context.points.history(accountId, undefined, 100);
  return history.rows.some((row) => row.operationId === operationId &&
    row.moduleId === POINTS_MODULE_ID && row.kind === "bonus");
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
        "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = ?",
      ).bind(context.channelId, POINTS_MODULE_ID).first<{ enabled: number }>();
      if (module?.enabled !== 1) return refund("disabled");
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
      if (error instanceof Error && definitiveLedgerErrors.has(error.message)) return refund("rejected");
      try {
        return await hasLedgerOperation(context, redemption.userId, ledgerOperationId)
          ? "fulfilled"
          : refund("rejected");
      } catch {
        return "pending";
      }
    }
  },
};
