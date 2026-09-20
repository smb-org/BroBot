import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/registry", () => ({
  MODULES: [{
    id: "werbung",
    settingsSchema: {},
    defaultSettings: {},
    broadcasterScopes: ["channel:read:ads"],
  }],
}));

import { ModulePage } from "../../src/dashboard/module-panels";

describe("Broadcaster-Scope-Hinweis im Modulpanel", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  const modules = [{
    id: "werbung",
    enabled: true,
    settings: "{}",
    requiredBroadcasterScopes: ["channel:read:ads"],
    missingBroadcasterScopes: ["channel:read:ads"],
  }];

  it("zeigt dem Broadcaster die aktiven Zustimmungsschaltfläche und Begründung", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="werbung"
      ownRole="broadcaster"
      modules={modules}
      activeModules={[{ moduleId: "werbung", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByText("Das Modul „Werbung“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.")).toBeInTheDocument();
    expect(screen.getByText("channel:read:ads")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Broadcaster-Berechtigungen erteilen" })).toHaveAttribute(
      "href",
      "/auth/channels/kanal-a/broadcaster-scopes/werbung",
    );
  });

  it.each(["verwalter", "bediener"] as const)("zeigt %s denselben Bedarf, aber keinen auslösbaren Knopf", (ownRole) => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="werbung"
      ownRole={ownRole}
      modules={modules}
      activeModules={[{ moduleId: "werbung", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Broadcaster-Berechtigungen erteilen" })).toBeDisabled();
    expect(screen.getByText("Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.")).toBeInTheDocument();
  });

  it.each([
    ["de-DE", "Benötigte Broadcaster-Berechtigungen", "Werbepausen erkennen", "Fehlt", "Erteilt", "Broadcaster-Berechtigungen erteilen", "Das Modul „Werbung“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen."],
    ["en-US", "Required broadcaster permissions", "Detect ad breaks", "Missing", "Granted", "Grant broadcaster permissions", "The module “Ad breaks” is disabled because broadcaster permissions are missing."],
  ] as const)("zeigt jede Berechtigung mit Zweck, Bezeichner und LED-Wort auf %s", async (language, heading, purpose, missing, granted, action, notice) => {
    Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
    render(<ModulePage
      channelId="kanal-a"
      moduleId="werbung"
      ownRole="broadcaster"
      modules={[{
        id: "werbung",
        enabled: true,
        settings: "{}",
        requiredBroadcasterScopes: ["channel:read:ads", "channel:manage:ads"],
        missingBroadcasterScopes: ["channel:read:ads"],
      }]}
      activeModules={[{ moduleId: "werbung", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: heading, level: 2 })).toBeInTheDocument();
    expect(await screen.findByText(purpose)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: action })).toBeInTheDocument();
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.getByText("channel:read:ads")).toBeInTheDocument();
    expect(screen.getByText("channel:manage:ads")).toBeInTheDocument();
    expect(screen.getByText(missing)).toBeInTheDocument();
    expect(screen.getByText(granted)).toBeInTheDocument();
    expect(document.querySelectorAll(".scope-zeile__icon")).toHaveLength(2);
    expect(document.querySelector(".module-state__icon")).toBeInTheDocument();
  });

  it("blendet die Zustimmungsfläche aus, wenn alle Berechtigungen erteilt sind", async () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="werbung"
      ownRole="broadcaster"
      modules={[{
        id: "werbung",
        enabled: true,
        settings: "{}",
        requiredBroadcasterScopes: ["channel:read:ads"],
        missingBroadcasterScopes: [],
      }]}
      activeModules={[{ moduleId: "werbung", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "Werbung", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Benötigte Broadcaster-Berechtigungen", level: 2 })).not.toBeInTheDocument();
  });
});
