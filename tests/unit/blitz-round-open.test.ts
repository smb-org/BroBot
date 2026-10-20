import { describe, expect, it, vi } from "vitest";

import type { ModulePointsAccess } from "../../src/modules/contract";
import type { BlitzQuestionRepository } from "../../src/modules/blitz_round/repository";
import { loadBlitzModuleActivationRevision, openBlitzRound } from "../../src/modules/blitz_round/service";
import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";

const question = {
  id: "fictional-question-cloud",
  revision: 1,
  kind: "scramble" as const,
  prompt: "CLOUD",
  answers: ["CLOUD"],
  enabled: true,
  lastUsedAt: null,
  createdAt: "2030-01-01T12:00:00.000Z",
  updatedAt: "2030-01-01T12:00:00.000Z",
};

describe("open Blitz round", () => {
  it("loads activation generation independently of module settings revision [protects=non-activation settings edits preserve the round generation; fails_when=the general module revision is used as the activation generation; no_claim=uses a mocked D1 row and does not test module toggle transactions]", async () => {
    const first = vi.fn(() => Promise.resolve({ activation_generation: 12, revision: 99 }));
    const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
    const db = {
      prepare,
    } as unknown as D1Database;

    await expect(loadBlitzModuleActivationRevision(db, "fictional_channel")).resolves.toBe(12);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("last_disabled_revision AS activation_generation"));
  });

  it("stores the module activation revision in the opened round data [protects=resolution hooks can identify the activation generation that opened their round; fails_when=round data omits or changes the opening module revision; no_claim=uses in-memory round and repository boundaries and does not exercise Durable Object persistence]", async () => {
    const repository = {
      pick: vi.fn(() => Promise.resolve(question)),
      markUsed: vi.fn(() => Promise.resolve()),
    } as unknown as BlitzQuestionRepository;
    const roundOpen = vi.fn((...args: [string, unknown]) => {
      void args;
      return Promise.resolve();
    });
    const points = { rounds: { open: roundOpen } } as unknown as ModulePointsAccess;

    const opened = await openBlitzRound({
      channelId: "fictional_channel",
      settings: blitzRoundDefaultsForLanguage("en"),
      language: "en",
      points,
      repository,
      moduleActivationRevision: 7,
    } as unknown as Parameters<typeof openBlitzRound>[0]);

    expect(opened.data.moduleActivationRevision).toBe(7);
    expect(roundOpen.mock.calls[0]?.[1]).toMatchObject({ moduleActivationRevision: 7 });
  });
});
