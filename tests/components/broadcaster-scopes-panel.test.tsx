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
  afterEach(() => cleanup());

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
      "/auth/channels/kanal-a/broadcaster-scopes",
    );
  });

  it("zeigt Verwaltern denselben Bedarf, aber keinen auslösbaren Knopf", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="werbung"
      ownRole="verwalter"
      modules={modules}
      activeModules={[{ moduleId: "werbung", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Broadcaster-Berechtigungen erteilen" })).toBeDisabled();
    expect(screen.getByText("Nur der Broadcaster dieses Kanals darf diese Zustimmung erteilen.")).toBeInTheDocument();
  });
});
