import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ChatCommandsHelp } from "../../src/dashboard/ui";
import { deriveModuleHowToPlay, moduleChatCommandsForSettings } from "../../src/dashboard/module-how-to-play-model";
import { CHAT_VOTING_CHAT_COMMANDS } from "../../src/modules/chat_voting/contracts/chat-commands";
import { MODULES } from "../../src/modules/registry";

afterEach(cleanup);

describe("ChatCommandsHelp", () => {
  it("keeps the zero-command button available for game start help", () => {
    const quiz = MODULES.find((module) => module.id === "quiz");
    if (quiz === undefined) throw new Error("Quiz module is missing.");
    const howToPlayRows = deriveModuleHowToPlay(quiz, quiz.defaultSettings, "de");

    render(<ChatCommandsHelp commands={[]} howToPlayRows={howToPlayRows} language="de" />);

    fireEvent.click(screen.getByRole("button", { name: "Chatbefehle · 0" }));
    const help = screen.getByRole("dialog", { name: "Chatbefehle" });
    const content = help.textContent;
    expect(content).toContain("Start: Live-Cockpit → Quiz starten (nur wenn der Stream läuft)");
    expect(content).toContain("Mitspielen: Im Chat mit 1–4 antworten");
    expect(content.indexOf("Start:")).toBeLessThan(content.indexOf("Chatbefehle"));
  });

  it("keeps settings-derived help closed while module settings load", () => {
    const quiz = MODULES.find((module) => module.id === "quiz");
    if (quiz === undefined) throw new Error("Quiz module is missing.");
    const howToPlayRows = deriveModuleHowToPlay(quiz, quiz.defaultSettings, "de");

    render(<ChatCommandsHelp commands={[]} howToPlayRows={howToPlayRows} language="de" loading />);

    const button = screen.getByRole("button", { name: "Chatbefehle · 0" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows bilingual help from the module declaration with copy action", () => {
    render(<ChatCommandsHelp commands={CHAT_VOTING_CHAT_COMMANDS} language="en" />);

    fireEvent.click(screen.getByRole("button", { name: "Chat commands · 1" }));
    const help = screen.getByRole("dialog", { name: "Chat commands" });
    expect(help.textContent).toContain("!vote [type] [question]");
    expect(help.textContent).toContain("Starts or ends a chat vote.");
    expect(help.textContent).toContain("Available in chat to: moderators and broadcasters");
    expect(within(help).getByRole("button", { name: "Copy: !vote [type] [question]" }).textContent).toContain("Copy");
  });

  it("shows each configurable command's own minimum role", () => {
    const clips = MODULES.find((module) => module.id === "clips");
    const votekick = MODULES.find((module) => module.id === "votekick");
    if (clips === undefined || votekick === undefined) throw new Error("Command modules are missing.");
    const commands = [
      ...moduleChatCommandsForSettings(clips, { ...clips.defaultSettings as object, commandMinimumRole: "moderator" }, "de"),
      ...moduleChatCommandsForSettings(votekick, { ...votekick.defaultSettings as object, starterMinRole: "vip" }, "de"),
    ];

    render(<ChatCommandsHelp commands={commands} language="de" />);
    fireEvent.click(screen.getByRole("button", { name: "Chatbefehle · 2" }));
    const help = screen.getByRole("dialog", { name: "Chatbefehle" });
    const clipCommand = within(help).getByText("!clip").closest("article");
    const votekickCommand = within(help).getByText("!votekick @user").closest("article");

    expect(clipCommand?.textContent).toContain("Im Chat ausführbar für: Moderatoren und Broadcaster");
    expect(clipCommand?.textContent).not.toContain("Votekick-Einstellungen");
    expect(votekickCommand?.textContent).toContain("Im Chat ausführbar für: VIPs, Moderatoren und Broadcaster");
  });

  it("lists Heist and configured Duel commands in chat help", () => {
    const heist = MODULES.find((module) => module.id === "heist");
    const duel = MODULES.find((module) => module.id === "duel");
    if (heist === undefined || duel === undefined) throw new Error("Game modules are missing.");
    const duelSettings = { ...duel.defaultSettings as object, challengeCommand: "!challenge", acceptCommand: "!accept" };
    const commands = [
      ...moduleChatCommandsForSettings(heist, heist.defaultSettings, "de"),
      ...moduleChatCommandsForSettings(duel, duelSettings, "de"),
    ];

    render(<ChatCommandsHelp commands={commands} language="de" />);
    fireEvent.click(screen.getByRole("button", { name: "Chatbefehle · 3" }));
    const help = screen.getByRole("dialog", { name: "Chatbefehle" });

    expect(help.textContent).toContain("!heist <Einsatz>");
    expect(help.textContent).toContain("!challenge [@login] [Einsatz]");
    expect(help.textContent).toContain("!accept");
  });
});
