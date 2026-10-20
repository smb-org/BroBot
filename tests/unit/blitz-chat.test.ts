import { expect, it, vi } from "vitest";
import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import type { BlitzRoundSettings } from "../../src/modules/blitz_round/contracts";
import { blitzRoundDefaultsForLanguage } from "../../src/modules/blitz_round/locale";
import { processBlitzMessage } from "../../src/modules/blitz_round/service";

const message = (text: string): ModuleEvent<BlitzRoundSettings> => ({
  triggerId: "fictional-trigger", settings: blitzRoundDefaultsForLanguage("en"), receivedAt: "2030-01-01T00:00:00.000Z", actor: null, chatStatus: ["viewer"],
  subscriptionType: "channel.chat.message", channelId: "fictional_channel",
  payload: { chatter_user_id: "fictional_viewer", chatter_user_login: "frostfern", message_id: "fictional-message", message: { text } },
});

it("records matching chat messages without posting a reply [protects=only normalized correct messages reach the five-second answer path with their message identity; fails_when=wrong answers book participants or any answer emits chat output; no_claim=the round access is mocked and does not prove ledger atomicity]", async () => {
  const answer = vi.fn(() => Promise.resolve({ status: "recorded", replayed: false, first: true }));
  const active = vi.fn(() => Promise.resolve({ roundId: "fictional-round", state: "open", data: { answers: ["Cloud"] } }));
  const context = { points: { rounds: { active, answer } }, botUserId: () => Promise.resolve("fictional_bot") } as unknown as ModuleExecutionContext;
  expect(await processBlitzMessage(message("rain"), context)).toEqual({ actions: [], diagnostics: [] });
  expect(answer).not.toHaveBeenCalled();
  expect(await processBlitzMessage(message("  C.LOUD!! "), context)).toEqual({ actions: [], diagnostics: [] });
  expect(answer).toHaveBeenCalledExactlyOnceWith("fictional-round", "msg:fictional-message", "fictional_viewer", "frostfern", 5, Date.parse("2030-01-01T00:00:00.000Z"));
  const foreign = message("cloud");
  foreign.payload = { ...foreign.payload, source_broadcaster_user_id: "other_fictional_channel" };
  await processBlitzMessage(foreign, context);
  expect(answer).toHaveBeenCalledOnce();
});
