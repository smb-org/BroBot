import { describe, expect, it } from "vitest";

import { TEXT_COMMAND_DEFAULT_TEXTS, TEXT_COMMAND_DEFAULT_USAGE_TEXT } from "../../src/modules/text_commands/contracts/chat-defaults";
import { convertLeadingSlashCommand, parseLeadingSlashCommand } from "../../src/modules/text_commands/panel/slash-command";

describe("text command slash input", () => {
  it("parses fixed and ranged caller timeouts with an optional reason and response body", () => {
    expect(parseLeadingSlashCommand("/timeout {user} 45\nTimed out for {timeout.duration}")).toEqual({
      status: "valid",
      command: "timeout",
      minSeconds: 45,
      maxSeconds: 45,
      reason: "",
      bodyText: "Timed out for {timeout.duration}",
    });
    expect(parseLeadingSlashCommand("/timeout {user} 30-300 repeated spam\nPlease slow down.")).toEqual({
      status: "valid",
      command: "timeout",
      minSeconds: 30,
      maxSeconds: 300,
      reason: "repeated spam",
      bodyText: "Please slow down.",
    });
  });

  it.each([
    "/timeout someone-else 30",
    "/timeout {user} 0",
    "/timeout {user} 300-30",
    "/timeout {user} 1209601",
    "/timeout {user}",
  ])("rejects invalid timeout syntax: %s", (value) => {
    expect(parseLeadingSlashCommand(value)).toMatchObject({ status: "invalid", command: "timeout" });
  });

  it("parses announcement text and the shoutout target marker", () => {
    expect(parseLeadingSlashCommand("/announce Stream starts now!")).toEqual({
      status: "valid", command: "announce", bodyText: "Stream starts now!",
    });
    expect(parseLeadingSlashCommand("/shoutout {target}\nCheck out the channel!")).toEqual({
      status: "valid", command: "shoutout", bodyText: "Check out the channel!",
    });
    expect(parseLeadingSlashCommand("/shoutout some-user")).toMatchObject({ status: "invalid", command: "shoutout" });
    expect(parseLeadingSlashCommand("/announce")).toMatchObject({ status: "invalid", command: "announce" });
  });

  it("offers suggestions for partial input and warns for unsupported slash commands", () => {
    expect(parseLeadingSlashCommand("/")).toEqual({ status: "suggestions", fragment: "" });
    expect(parseLeadingSlashCommand("/time")).toEqual({ status: "suggestions", fragment: "time" });
    expect(parseLeadingSlashCommand("/permit everyone")).toEqual({ status: "unsupported" });
    expect(parseLeadingSlashCommand("hello /announce later")).toEqual({ status: "none" });
  });

  it("converts a parsed directive into structured draft fields", () => {
    const initial = {
      kind: "text" as const,
      text: "",
      responseType: "reply" as const,
      variableAction: { name: "score", operation: "add" as const, amount: 1 },
      timeoutAction: null,
      usageText: "",
      minimumTier: "everyone" as const,
    };
    const timeout = parseLeadingSlashCommand("/timeout {user} 30-300 repeated spam\nTimed out");
    if (timeout.status !== "valid") throw new Error("Timeout example did not parse.");
    expect(convertLeadingSlashCommand(initial, timeout, { text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT })).toMatchObject({
      kind: "timeout",
      text: "Timed out",
      variableAction: initial.variableAction,
      timeoutAction: { minSeconds: 30, maxSeconds: 300, reason: "repeated spam", fallbackText: "" },
    });

    const announcement = parseLeadingSlashCommand("/announce Breaking news!");
    if (announcement.status !== "valid") throw new Error("Announcement example did not parse.");
    expect(convertLeadingSlashCommand(initial, announcement, { text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT }))
      .toMatchObject({ kind: "text", responseType: "announcement", text: "Breaking news!" });
    expect(convertLeadingSlashCommand({ ...initial, kind: "shoutout" }, announcement, { text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT }))
      .toMatchObject({ kind: "text", responseType: "announcement", timeoutAction: null });

    const shoutout = parseLeadingSlashCommand("/shoutout {target}");
    if (shoutout.status !== "valid") throw new Error("Shoutout example did not parse.");
    expect(convertLeadingSlashCommand(initial, shoutout, { text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT }))
      .toMatchObject({ kind: "shoutout", responseType: "say", text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout, usageText: TEXT_COMMAND_DEFAULT_USAGE_TEXT });
  });

  it("parses long pathological input in linear time", () => {
    const start = performance.now();
    const blanks = " ".repeat(50_000);
    expect(parseLeadingSlashCommand(`/announce${blanks}`)).toEqual({ status: "invalid", command: "announce" });
    expect(parseLeadingSlashCommand(`/timeout${blanks}{user}${blanks}x${blanks}\r`)).toEqual({ status: "invalid", command: "timeout" });
    expect(parseLeadingSlashCommand(`/timeout {user} ${"9".repeat(50_000)}`)).toEqual({ status: "invalid", command: "timeout" });
    expect(parseLeadingSlashCommand(`/timeout {user} 5${blanks}reason`)).toMatchObject({ status: "valid", reason: "reason" });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
