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

const serverRead = (channelId: string, guildId = "990000000000000121", vipRole: string | null = null): DiscordServerRead => ({
  configured: true,
  connection: { channelId, guildId, connectedAt: "2026-11-26T10:00:00.000Z", connectedBy: "fictional-member" },
  mappings: { vip: vipRole, moderator: null },
  state: "connected",
  guildName: guildId === "990000000000000123" ? "Moonlit Cove" : "Lantern Harbor",
  roles: [
    { id: "990000000000000122", name: "VIP Crew", position: 2, permissions: "0", managed: false },
    { id: "990000000000000124", name: "Moonlit Crew", position: 3, permissions: "0", managed: false },
  ],
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

  it("keeps callback feedback pending across another channel and does not restore it after conflict and save", async () => {
    const navigationName = "https://brobot.example/channels/channel-a/modules/discord?discord=error";
    vi.spyOn(performance, "getEntriesByType").mockImplementation(() => [
      { name: navigationName } as PerformanceNavigationTiming,
    ]);

    const otherChannel = renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-b" language="en" canManage /></UiProvider>);
    await waitFor(() => expect(mocks.readDiscordServer).toHaveBeenCalledWith("channel-b", expect.any(AbortSignal)));
    await screen.findByText("Lantern Harbor");
    expect(screen.queryByText("The Discord server connection did not finish.", { selector: ".discord-server-panel__message" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect server" }));
    const disconnectDialog = await screen.findByRole("dialog", { name: "Disconnect Discord server?" });
    fireEvent.click(within(disconnectDialog).getByRole("button", { name: "Disconnect server" }));
    expect(await screen.findByText("Discord server disconnected.", { selector: ".discord-server-panel__message" })).toBeInTheDocument();
    otherChannel.unmount();

    const destination = renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    expect(await screen.findByText("The Discord server connection did not finish.", { selector: ".discord-server-panel__message" })).toBeInTheDocument();

    mocks.saveDiscordMappings
      .mockRejectedValueOnce(new Error("discord_server_changed"))
      .mockResolvedValueOnce({ mappings: { vip: "990000000000000122", moderator: null } });
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "VIP Crew", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Server changed. Status reloaded.", {
      selector: ".discord-server-panel__message",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "VIP Crew", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.saveDiscordMappings).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Role mappings saved.", { selector: ".sr-only" })).toBeInTheDocument();
    const messageSlot = destination.container.querySelector<HTMLElement>(".discord-server-panel__message");
    expect(messageSlot).not.toBeNull();
    await waitFor(() => expect(messageSlot?.textContent).not.toContain("The Discord server connection did not finish."));
    destination.unmount();

    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    expect(screen.queryByText("The Discord server connection did not finish.", { selector: ".discord-server-panel__message" })).not.toBeInTheDocument();
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
      .mockResolvedValueOnce(serverRead("channel-a", "990000000000000121", "990000000000000122"))
      .mockResolvedValue(serverRead("channel-a", "990000000000000123", "990000000000000124"));
    mocks.saveDiscordMappings.mockRejectedValue(new Error("discord_server_changed"));
    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "No role", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Server changed. Status reloaded.", {
      selector: ".discord-server-panel__message",
    })).toBeInTheDocument();
    expect(mocks.saveDiscordMappings).toHaveBeenCalledWith("channel-a", "990000000000000121", {
      vip: null, moderator: null,
    });
    expect(mocks.readDiscordServer).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Moonlit Cove")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "VIP role" })).toHaveTextContent("Moonlit Crew");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.saveDiscordMappings).toHaveBeenCalledTimes(1);
  });

  it("reloads disconnected status and keeps the conflict message fixed", async () => {
    mocks.readDiscordServer
      .mockReset()
      .mockResolvedValueOnce(serverRead("channel-a"))
      .mockResolvedValue({
        ...serverRead("channel-a"),
        connection: null,
        state: "not_connected",
      });
    mocks.saveDiscordMappings.mockRejectedValue(new Error("discord_server_not_connected"));
    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "VIP Crew", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Server disconnected. Status reloaded.", {
      selector: ".discord-server-panel__message",
    })).toBeInTheDocument();
    expect(await screen.findByText("No Discord server connected")).toBeInTheDocument();
    expect(mocks.saveDiscordMappings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("blocks mapping saves when a conflict reload fails and retries with fresh mappings", async () => {
    mocks.readDiscordServer
      .mockReset()
      .mockResolvedValueOnce(serverRead("channel-a", "990000000000000121", "990000000000000122"))
      .mockRejectedValueOnce(new Error("status reload failed"))
      .mockResolvedValueOnce(serverRead("channel-a", "990000000000000123", "990000000000000124"));
    mocks.saveDiscordMappings.mockRejectedValue(new Error("discord_server_changed"));
    renderWithQuery(<UiProvider><DiscordServerPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByText("Lantern Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "No role", hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Could not reload Discord status.", {
      selector: ".discord-server-panel__message",
    })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Moonlit Cove")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "VIP role" })).toHaveTextContent("Moonlit Crew");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(mocks.readDiscordServer).toHaveBeenCalledTimes(3);
    expect(mocks.saveDiscordMappings).toHaveBeenCalledTimes(1);
  });

});
