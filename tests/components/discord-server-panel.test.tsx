import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import DiscordServerPanel from "../../src/modules/discord/panel";
import type { DiscordServerRead } from "../../src/modules/discord/panel/service";
import { DiscordServerStatus } from "../../src/modules/discord/panel/status";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  readDiscordServer: vi.fn(),
  saveDiscordMappings: vi.fn(),
}));

vi.mock("../../src/modules/discord/panel/service", () => mocks);

const serverRead = (channelId: string, guildId = "990000000000000121"): DiscordServerRead => ({
  configured: true,
  connection: { channelId, guildId, connectedAt: "2026-11-26T10:00:00.000Z", connectedBy: "fictional-member" },
  mappings: { vip: null, moderator: null },
  state: "connected",
  guildName: guildId === "990000000000000123" ? "Moonlit Cove" : "Lantern Harbor",
  roles: [{ id: "990000000000000122", name: "VIP Crew", position: 2, permissions: "0", managed: false }],
  rolesAvailable: true,
  botHighestRolePosition: 5,
});

afterEach(cleanup);

beforeEach(() => {
  mocks.readDiscordServer.mockReset().mockImplementation((channelId: string) => Promise.resolve(serverRead(channelId)));
  mocks.saveDiscordMappings.mockReset().mockResolvedValue({ mappings: { vip: "990000000000000122", moderator: null } });
  mocks.request.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Discord server status panel", () => {
  it.each([
    ["not_connected", "No Discord server connected"],
    ["not_available", "Discord server management is not available right now"],
    ["connected", "Discord server connected"],
    ["bot_removed", "BroBot no longer has access to this server"],
    ["permissions_missing", "BroBot needs Manage Roles or Administrator"],
    ["role_too_low", "Move BroBot's highest role above the mapped roles"],
    ["could_not_check", "Could not check Discord right now"],
  ] as const)("shows the stable message for %s", (state, expected) => {
    render(<DiscordServerStatus state={state} language="en" />);
    expect(screen.getByRole("status")).toHaveTextContent(expected);
  });

  it("shows callback feedback only on its Discord channel and only once", async () => {
    let navigationName = "https://brobot.example/channels/channel-a/modules/points?discord=connected";
    vi.spyOn(performance, "getEntriesByType").mockImplementation(() => [
      { name: navigationName } as PerformanceNavigationTiming,
    ]);

    const otherModule = renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    expect(screen.queryByText("Discord server connected", { selector: ".discord-server-panel__message" })).not.toBeInTheDocument();
    otherModule.unmount();

    navigationName = "https://brobot.example/channels/channel-a/modules/discord?discord=connected";

    const otherChannel = renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-b" language="en" canManage /></UiProvider>);
    await waitFor(() => expect(mocks.readDiscordServer).toHaveBeenCalledWith("channel-b", expect.any(AbortSignal)));
    expect(screen.queryByText("Discord server connected", { selector: ".discord-server-panel__message" })).not.toBeInTheDocument();
    otherChannel.unmount();

    const destination = renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    expect(await screen.findByText("Discord server connected", { selector: ".discord-server-panel__message" })).toBeInTheDocument();
    destination.unmount();

    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await waitFor(() => expect(mocks.readDiscordServer).toHaveBeenCalledTimes(4));
    expect(screen.queryByText("Discord server connected", { selector: ".discord-server-panel__message" })).not.toBeInTheDocument();
  });

  it("confirms before dashboard navigation with an unsaved mapping and discards to proceed", async () => {
    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "VIP Crew", hidden: true }));

    let navigations = 0;
    const navigate = (): void => { navigations += 1; };
    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });

    expect(navigations).toBe(0);
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(within(dialog).getByRole("button", { name: "Save and switch" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Discard and switch" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue editing" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard and switch" }));

    expect(navigations).toBe(1);
  });

  it("reloads status and shows a fixed message when mappings target a replaced server", async () => {
    mocks.readDiscordServer
      .mockReset()
      .mockResolvedValueOnce(serverRead("channel-a"))
      .mockResolvedValue(serverRead("channel-a", "990000000000000123"));
    mocks.saveDiscordMappings.mockRejectedValue(new Error("discord_server_changed"));
    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "VIP Crew", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Server changed. Status reloaded.", {
      selector: ".discord-server-panel__message",
    })).toBeInTheDocument();
    expect(mocks.saveDiscordMappings).toHaveBeenCalledWith("channel-a", "990000000000000121", {
      vip: "990000000000000122", moderator: null,
    });
    expect(mocks.readDiscordServer).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Moonlit Cove")).toBeInTheDocument();
  });
});
