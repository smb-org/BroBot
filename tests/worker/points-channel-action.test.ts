import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ModuleExecutionContext } from "../../src/modules/contract";
import { pointsModule } from "../../src/modules/points";
import { creditPointsAction } from "../../src/modules/points/actions/credit-points";
import { createModuleActionExecutionContext } from "../../src/worker/module-action-context";
import {
  clearPointObjectAlarms,
  insertPointChannel,
  pointObject,
  runMigrations,
  testCard,
} from "./points-test-helpers";

const channel = (channelId: string, enabled: boolean) => env.DB.prepare(
  "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', ?, '{}', 1)",
).bind(channelId, enabled ? 1 : 0).run();

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
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(75);
    await expect(object.pointAccount("points", redemption.userId)).resolves.toMatchObject({ login: redemption.userLogin });

    await expect(execute(context)).resolves.toBe("fulfilled");
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(75);
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
    const context: ModuleExecutionContext = {
      ...realContext,
      points: {
        ...realContext.points,
        apply: () => Promise.reject(new Error("storage unavailable")),
        history: () => Promise.reject(new Error("storage unavailable")),
      },
    };

    await expect(execute(context)).resolves.toBe("pending");
  });

  it(`refunds after a failed write when history confirms no credit was recorded (${testCard("a successful idempotency lookup distinguishes a non-commit from a pending write", "a confirmed missing ledger operation remains pending")})`, async () => {
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

  it(`confirms an ambiguous write from its ledger record (${testCard("a committed credit is acknowledged after the apply response is lost", "the action leaves a committed credit pending or credits it again", "the write and subsequent history read use the real local points ledger")})`, async () => {
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
    await expect(object.pointBalance("points", redemption.userId)).resolves.toBe(75);
  });
});

