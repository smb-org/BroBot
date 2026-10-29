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
    expect(guide.textContent).toContain("(für alle)");
  });

  it("keeps the rows in place while loading and hides them from assistive technology", () => {
    const heist = moduleById("heist");
    const { rerender } = render(<ModuleHowToPlay module={heist} settings={heist.defaultSettings} language="de" loading />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide).toHaveAttribute("aria-busy", "true");
    const loadingRows = guide.querySelectorAll("p");
    expect(loadingRows).toHaveLength(1);
    expect(loadingRows[0]).toHaveAttribute("aria-hidden", "true");

    rerender(<ModuleHowToPlay module={heist} settings={heist.defaultSettings} language="de" />);
    expect(guide.querySelectorAll("p")).toHaveLength(1);
    expect(guide.querySelector("p")).not.toHaveAttribute("aria-hidden");
  });

  it("renders configured Duel commands and labels the rule row as a note", () => {
    const duel = moduleById("duel");
    render(<ModuleHowToPlay module={duel} settings={settingsWith("duel", { challengeCommand: "!challenge", acceptCommand: "!accept" })} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("!challenge");
    expect(guide.textContent).toContain("!accept");
    expect(guide.textContent).toContain("Hinweis:");
    expect(guide.textContent.match(/Mitspielen:/gu)).toHaveLength(1);
  });

  it("renders the configured minimum Votekick role", () => {
    const votekick = moduleById("votekick");
    render(<ModuleHowToPlay module={votekick} settings={settingsWith("votekick", { starterMinRole: "moderator" })} language="de" />);

    const guide = screen.getByRole("region", { name: "So startest du" });
    expect(guide.textContent).toContain("(ab Moderator)");
    expect(guide.textContent).not.toContain("VIP");
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
