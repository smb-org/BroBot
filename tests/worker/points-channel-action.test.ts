import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ModuleExecutionContext } from "../../src/modules/contract";
import { pointsModule } from "../../src/modules/points";
import { creditPointsAction } from "../../src/modules/points/actions/credit-points";
import { DEFAULT_POINTS_SETTINGS } from "../../src/modules/points/contracts";
import { createModuleActionExecutionContext } from "../../src/worker/module-action-context";
import {
  clearPointObjectAlarms,
  insertPointChannel,
  pointObject,
  runMigrations,
  testCard,
} from "./points-test-helpers";

const channel = (channelId: string, enabled: boolean) => env.DB.prepare(
  "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', ?, ?, 1)",
).bind(channelId, enabled ? 1 : 0, JSON.stringify(DEFAULT_POINTS_SETTINGS)).run();

const actionContext = (channelId: string): ModuleExecutionContext =>
  createModuleActionExecutionContext(env, channelId, "points");

const redemption = {
  id: "redemption-123",
  rewardId: "reward-123",
  rewardTitle: "Community bonus",
  userId: "viewer_demo",
  userLogin: "nachtfalke",
  userName: "Nachtfalke",
  userInput: "",
  redeemedAt: "2026-11-10T12:00:00.000Z",
};

const execute = (
  context: ModuleExecutionContext,
  amount = 75,
  operationId = redemption.id,
) => creditPointsAction.execute(context, { redemption, config: { amount }, operationId });

beforeAll(runMigrations);
afterAll(clearPointObjectAlarms);

describe("points channel-points action", () => {
  it(`publishes the action through the points module (${testCard("the reward catalog can discover the credit action", "the action exists but is not registered on points")})`, () => {
    expect(pointsModule.channelPointsActions?.find((action) => action.id === "credit-points")).toBe(creditPointsAction);
  });

  it(`credits a redemption once and keeps the account login (${testCard("the redeemer receives the configured amount under the stable redemption operation", "the action does not credit, credits twice, or loses the account login", "the real points ledger runs through the local ChannelObject")})`, async () => {
    const channelId = `points-action-credit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const context = actionContext(channelId);
    const object = pointObject(channelId);

    await expect(execute(context)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
    await expect(object.pointAccount("points", redemption.userId)).resolves.toMatchObject({ login: redemption.userLogin });

    await expect(execute(context)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
    const history = await object.pointHistory("points", redemption.userId);
    expect(history.rows.filter((row) => row.operationId === "channel-points:credit-points:redemption-123")).toHaveLength(1);
  });

  it(`refunds a credit when the points module is disabled (${testCard("a disabled module never receives a balance write", "the action credits while points is disabled or leaves the redemption pending", "the enabled flag is read from local D1")})`, async () => {
    const channelId = `points-action-disabled-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, false);
    const object = pointObject(channelId);

    await expect(execute(actionContext(channelId))).resolves.toEqual({ refund: {
      de: "Das Punktesystem ist deaktiviert.",
      en: "The points module is disabled.",
    } });
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(0);
  });

  it(`refunds a definitive ledger rejection (${testCard("invalid viewer IDs rejected by the ledger are not left pending", "a known validation rejection is reported as an ambiguous outcome")})`, async () => {
    const channelId = `points-action-ledger-rejection-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realContext.points,
        apply: () => Promise.reject(new Error("invalid_account_id")),
      },
    };

    await expect(execute(context)).resolves.toEqual({ refund: {
      de: "Die Punktegutschrift wurde abgelehnt.",
      en: "The points credit was rejected.",
    } });
  });

  it(`validates the configured amount bounds (${testCard("only integer amounts from one through one million can be saved", "zero, fractions, or values above one million pass validation")})`, () => {
    expect(creditPointsAction.configSchema.safeParse({ amount: 1 }).success).toBe(true);
    expect(creditPointsAction.configSchema.safeParse({ amount: 1_000_000 }).success).toBe(true);
    for (const amount of [0, 1.5, 1_000_001, Number.NaN]) {
      expect(creditPointsAction.configSchema.safeParse({ amount }).success).toBe(false);
    }
  });

  it(`returns pending when both the ledger write and its idempotency lookup are unavailable (${testCard("an unverified storage outcome remains retryable", "a storage error is converted into a refund or success without proof")})`, async () => {
    const channelId = `points-action-pending-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    let lookups = 0;
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realContext.points,
        apply: () => Promise.reject(new Error("storage unavailable")),
        getOperation: () => {
          lookups += 1;
          return lookups === 1 ? Promise.resolve(null) : Promise.reject(new Error("storage unavailable"));
        },
      },
    };

    await expect(execute(context)).resolves.toBe("pending");
  });

  it(`refunds after a failed write when an exact lookup confirms no credit was recorded (${testCard("a successful idempotency lookup distinguishes a non-commit from a pending write", "a confirmed missing ledger operation remains pending")})`, async () => {
    const channelId = `points-action-not-committed-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realContext.points,
        apply: () => Promise.reject(new Error("temporary storage failure")),
      },
    };

    await expect(execute(context)).resolves.toEqual({ refund: {
      de: "Die Punktegutschrift wurde abgelehnt.",
      en: "The points credit was rejected.",
    } });
  });

  it(`confirms an ambiguous write from its ledger record (${testCard("a committed credit is acknowledged after the apply response is lost", "the action leaves a committed credit pending or credits it again", "the write and subsequent exact operation read use the real local points ledger")})`, async () => {
    const channelId = `points-action-confirmed-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    const realPoints = realContext.points;
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realPoints,
        apply: async (...args) => {
          await realPoints.apply(...args);
          throw new Error("response lost after commit");
        },
      },
    };
    const object = pointObject(channelId);

    await expect(execute(context)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
  });

  it(`keeps the original credit amount when a pending redemption is retried after an edit (${testCard("an existing ledger result wins over changed reward configuration", "the retry refunds or changes the amount that was already credited", "the first lookup succeeds and only post-commit recovery is unavailable")})`, async () => {
    const channelId = `points-action-edited-retry-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    const realPoints = realContext.points;
    let lookups = 0;
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realPoints,
        getOperation: async (...args) => {
          lookups += 1;
          if (lookups === 2) throw new Error("operation lookup unavailable");
          return realPoints.getOperation(...args);
        },
        history: () => Promise.reject(new Error("history unavailable")),
        apply: async (...args) => {
          await realPoints.apply(...args);
          throw new Error("response lost after commit");
        },
      },
    };
    const object = pointObject(channelId);

    await expect(execute(context, 75)).resolves.toBe("pending");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
    await expect(execute(realContext, 100)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
  });

  it(`initializes the start bonus before a redemption creates the viewer account (${testCard("redemption is equivalent to first-chat account initialization", "a first redemption suppresses the later start bonus or welcome note")})`, async () => {
    const channelId = `points-action-first-contact-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const context = actionContext(channelId);
    const object = pointObject(channelId);

    await expect(execute(context)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(175);
    const prepared = await object.preparePointChat("points", redemption.userId, redemption.userLogin, 100,
      Date.parse(redemption.redeemedAt), false, { amount: 0, windowMinutes: 10, dailyCap: 0 }, null,
      { messageId: "first-chat-message", language: "en", currencyName: "Points", safetyNetText: "" });
    expect(prepared).toMatchObject({ accountExisted: true, welcomePending: true, startBonus: 100 });
    expect(prepared.pendingWelcome).toMatchObject({
      accountId: redemption.userId,
      operationId: `bonus:${redemption.userId}`,
      messageId: "first-chat-message",
      kind: "start_bonus",
    });
    const history = await context.points.history(redemption.userId, undefined, 100);
    expect(history.rows.filter((row) => row.operationId === `bonus:${redemption.userId}`)).toHaveLength(1);
  });

  it(`recovers a committed credit beyond the first history page after a retry conflict (${testCard("exact operation recovery finds a commit after more than 100 newer ledger entries", "a committed credit is refunded when recent history omits it", "a stale preflight lookup simulates a concurrent redemption retry")})`, async () => {
    const channelId = `points-action-paged-history-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await channel(channelId, true);
    const realContext = actionContext(channelId);
    const realPoints = realContext.points;
    const object = pointObject(channelId);

    await expect(execute(realContext)).resolves.toBe("fulfilled");
    for (let index = 0; index < 101; index += 1) {
      await realPoints.apply(`newer-credit-${String(index).padStart(3, "0")}`, "bonus", [
        { accountId: redemption.userId, delta: 1, login: redemption.userLogin },
        { accountId: "__house", delta: -1 },
      ], { amount: 1 });
    }
    const history = await realPoints.history(redemption.userId, undefined, 100);
    expect(history.rows.some((row) => row.operationId === "channel-points:credit-points:redemption-123")).toBe(false);
    expect(await realPoints.getOperation("channel-points:credit-points:redemption-123")).toMatchObject({
      kind: "bonus",
      result: { amount: 75 },
    });

    let firstLookup = true;
    const retryContext: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realPoints,
        getOperation: async (ledgerOperationId) => {
          if (firstLookup) {
            firstLookup = false;
            return null;
          }
          return realPoints.getOperation(ledgerOperationId);
        },
        apply: () => Promise.reject(new Error("operation_conflict")),
      },
    };

    await expect(execute(retryContext)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(276);
  });
});

