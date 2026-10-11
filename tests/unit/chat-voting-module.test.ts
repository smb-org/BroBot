import { describe, expect, it } from "vitest";

import { chatVotingModule } from "../../src/modules/chat_voting";
import { parseVoteCommand } from "../../src/modules/chat_voting/domain";

describe("chat voting module", () => {
  it("declares the built-in vote command accepted by its parser", () => {
    const command = chatVotingModule.chatCommands?.find(({ name }) => name === "!vote");

    expect(command).toBeDefined();
    if (command === undefined) return;

    expect(command.name).toBe("!vote");
    expect(command.syntax).toBe("!vote [type] [question]");
    expect(command.description.de).toMatch(/\S/u);
    expect(command.description.en).toMatch(/\S/u);
    expect(command.minimumChatStatus).toBe("moderator");

    const [typeArgument, questionArgument] = command.arguments ?? [];
    expect(typeArgument?.name).toBe("type");
    expect(typeArgument?.hint.de).toMatch(/yesno.*scale.*01.*12.*text.*2–9.*end.*beendet/iu);
    expect(typeArgument?.hint.en).toMatch(/yesno.*scale.*01.*12.*text.*2–9.*end.*closes/iu);
    expect(questionArgument?.name).toBe("question");
    expect(questionArgument?.hint.de).toMatch(/\S/u);
    expect(questionArgument?.hint.en).toMatch(/\S/u);
    expect(parseVoteCommand(`${command.name} yesno`)).toMatchObject({ kind: "legacyAlias", alias: "yesno" });
  });
});
