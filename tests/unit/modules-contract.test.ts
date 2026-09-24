import { describe, expect, it } from "vitest";

import { apiErrorDetail, type ModuleResult } from "../../src/modules/contract";
import { clipsModule } from "../../src/modules/clips";
import { MODULES } from "../../src/modules/registry";

describe("Module contract", () => {
  it("preserves the order of semantic actions in a result", () => {
    const result: ModuleResult = {
      actions: [
        { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
        { kind: "overlay", type: "raid", payload: { viewers: 42 } },
      ],
      diagnostics: [],
    };

    expect(result.actions).toEqual([
      { kind: "chat", text: "Hallo", replyToMessageId: "message-1" },
      { kind: "overlay", type: "raid", payload: { viewers: 42 } },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("registers the clips module as default-enabled with a stream-live action", () => {
    expect(MODULES).toContain(clipsModule);
    expect(clipsModule.defaultEnabled).toBe(true);
    expect(clipsModule.immediateActions?.requires).toEqual(["streamLive"]);
  });

  describe("apiErrorDetail", () => {
    it("converts a nonempty twitchMessage into message for the API response", () => {
      expect(apiErrorDetail({ status: 429, twitchMessage: "slow down" }))
        .toEqual({ status: 429, message: "slow down" });
    });

    it("converts a null twitchMessage into message: null, instead of dropping the key (issue #201 follow-up)", () => {
      // A timeout/network error never had a Twitch body to read a message
      // from (`helixRequest` sets `message: null`) -- the converted key
      // still has to be `message: null`, matching what every API client
      // has always seen for that case, not simply absent.
      expect(apiErrorDetail({ status: null, twitchMessage: null }))
        .toEqual({ status: null, message: null });
    });

    it("leaves detail untouched when there's no twitchMessage key at all", () => {
      const detail = { status: 200 };
      expect(apiErrorDetail(detail)).toBe(detail);
    });

    it("leaves detail untouched when message is already present, twitchMessage included", () => {
      const detail = { message: "already set", twitchMessage: "ignored" };
      expect(apiErrorDetail(detail)).toBe(detail);
    });
  });
});
