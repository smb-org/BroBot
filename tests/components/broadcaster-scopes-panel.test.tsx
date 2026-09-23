import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/registry", () => ({
  MODULES: [{
    id: "ads",
    settingsSchema: {},
    defaultSettings: {},
    broadcasterScopes: ["channel:read:ads"],
  }],
}));

import { ModulePage } from "../../src/dashboard/module-panels";

describe("Broadcaster scope notice in the module panel", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  const modules = [{
    id: "ads",
    enabled: true,
    settings: "{}",
    requiredBroadcasterScopes: ["channel:read:ads"],
    missingBroadcasterScopes: ["channel:read:ads"],
  }];

  it("shows the broadcaster the active consent button and reasoning", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="ads"
      ownRole="broadcaster"
      modules={modules}
      activeModules={[{ moduleId: "ads", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByText("Das Modul „Werbung“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen.")).toBeInTheDocument();
    expect(screen.getByText("channel:read:ads")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Broadcaster-Berechtigungen erteilen" })).toHaveAttribute(
      "href",
      "/auth/channels/kanal-a/broadcaster-scopes/ads",
    );
  });

  it.each(["manager", "operator"] as const)("shows %s the same requirement, but no actionable button", (ownRole) => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="ads"
      ownRole={ownRole}
      modules={modules}
      activeModules={[{ moduleId: "ads", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Broadcaster-Berechtigungen erteilen" })).toBeDisabled();
    expect(screen.getByText("Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.")).toBeInTheDocument();
  });

  it.each([
    ["de-DE", "Benötigte Broadcaster-Berechtigungen", "Werbepausen erkennen", "Fehlt", "Erteilt", "Broadcaster-Berechtigungen erteilen", "Das Modul „Werbung“ ist deaktiviert, weil Broadcaster-Berechtigungen fehlen."],
    ["en-US", "Required broadcaster permissions", "Detect ad breaks", "Missing", "Granted", "Grant broadcaster permissions", "The module “Ad breaks” is disabled because broadcaster permissions are missing."],
  ] as const)("shows each permission with purpose, identifier and LED word in %s", async (language, heading, purpose, missing, granted, action, notice) => {
    Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
    render(<ModulePage
      channelId="kanal-a"
      moduleId="ads"
      ownRole="broadcaster"
      modules={[{
        id: "ads",
        enabled: true,
        settings: "{}",
        requiredBroadcasterScopes: ["channel:read:ads", "channel:manage:ads"],
        missingBroadcasterScopes: ["channel:read:ads"],
      }]}
      activeModules={[{ moduleId: "ads", settings: "{}" }]}
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
    expect(document.querySelectorAll(".scope-row__icon")).toHaveLength(2);
    expect(document.querySelector(".module-state__icon")).toBeInTheDocument();
  });

  it("hides the consent area when all permissions are granted", async () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="ads"
      ownRole="broadcaster"
      modules={[{
        id: "ads",
        enabled: true,
        settings: "{}",
        requiredBroadcasterScopes: ["channel:read:ads"],
        missingBroadcasterScopes: [],
      }]}
      activeModules={[{ moduleId: "ads", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(await screen.findByRole("heading", { name: "Werbung", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Benötigte Broadcaster-Berechtigungen", level: 2 })).not.toBeInTheDocument();
  });
});
