import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { ModuleHowToPlay } from "../../src/dashboard/ModuleHowToPlay";
import { ChatCommandsHelp } from "../../src/dashboard/ui";
import { moduleChatCommandsForSettings } from "../../src/dashboard/module-how-to-play-model";

afterEach(cleanup);

const moduleById = (moduleId: string) => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  if (module === undefined) throw new Error(`Module ${moduleId} is missing.`);
  return module;
};

const settingsWith = (moduleId: string, overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...(moduleById(moduleId).defaultSettings as Record<string, unknown>),
  ...overrides,
});

describe("ModuleHowToPlay", () => {
  it("renders cockpit start and chat participation for Quiz", () => {
    const quiz = moduleById("quiz");
    render(<ModuleHowToPlay module={quiz} settings={quiz.defaultSettings} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("Live-Cockpit");
    expect(guide.textContent).toContain("Quiz starten");
    expect(guide.textContent).toContain("1–4");
  });

  it("renders the Heist chat command as both its start and join method", () => {
    const heist = moduleById("heist");
    render(<ModuleHowToPlay module={heist} settings={heist.defaultSettings} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("!heist <Einsatz>");
    expect(guide.textContent).toContain("alle");
  });

  it("renders the actions slot inside the guide so a full page header stays untouched", () => {
    const heist = moduleById("heist");
    render(<ModuleHowToPlay module={heist} settings={heist.defaultSettings} language="de" actions={<button type="button">Aktion</button>} />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide).toContainElement(screen.getByRole("button", { name: "Aktion" }));
  });

  it("renders configured Duel commands", () => {
    const duel = moduleById("duel");
    render(<ModuleHowToPlay module={duel} settings={settingsWith("duel", { challengeCommand: "!challenge", acceptCommand: "!accept" })} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("!challenge");
    expect(guide.textContent).toContain("!accept");
  });

  it("renders the configured minimum Votekick role", () => {
    const votekick = moduleById("votekick");
    render(<ModuleHowToPlay module={votekick} settings={settingsWith("votekick", { starterMinRole: "moderator" })} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("Moderatoren+");
    expect(guide.textContent).not.toContain("VIP+");
  });

  it("lists Heist and configured Duel commands in chat command help", () => {
    const heist = moduleById("heist");
    const duel = moduleById("duel");
    const commands = [
      ...moduleChatCommandsForSettings(heist, heist.defaultSettings, "de"),
      ...moduleChatCommandsForSettings(duel, settingsWith("duel", { challengeCommand: "!challenge", acceptCommand: "!accept" }), "de"),
    ];
    render(<ChatCommandsHelp commands={commands} language="de" />);

    fireEvent.click(screen.getByRole("button", { name: "Chatbefehle · 3" }));
    const help = screen.getByRole("dialog", { name: "Chatbefehle" });
    expect(help.textContent).toContain("!heist <Einsatz>");
    expect(help.textContent).toContain("!challenge [@login] [Einsatz]");
    expect(help.textContent).toContain("!accept");
  });
});
