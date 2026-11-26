import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { moduleQueryKey, useDashboardQueryClient } from "../../src/dashboard/data";
import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import DiscordServerPanel from "../../src/modules/discord/panel";
import { clickSelectOption } from "../query-test-utils";

const server = (overrides: Record<string, unknown> = {}) => ({
  configured: true,
  connection: { channelId: "fictional-channel", guildId: "990000000000000101", connectedAt: "2026-11-24T10:00:00.000Z", connectedBy: "fictional-manager" },
  mappings: { vip: null, moderator: null },
  state: "connected",
  guildName: "Amber Harbor",
  roles: [{ id: "990000000000000102", name: "Harbor VIP", position: 3, permissions: "0", managed: false }],
  rolesAvailable: true,
  botHighestRolePosition: 5,
  teardown: false,
  disconnecting: false,
  teardownRemaining: 0,
  locked: false,
  globalTokenLocked: false,
  chatHintEnabled: true,
  hintSettingsRevision: 1,
  ...overrides,
});

const json = (body: unknown, status = 200): Promise<Response> => Promise.resolve(new Response(JSON.stringify(body), { status }));
const requestHref = (input: RequestInfo | URL): string => typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const renderPanel = (): void => {
  render(<DashboardDataProvider><DiscordServerPanel channelId="fictional-channel" language="en" canManage /></DashboardDataProvider>);
};

const QueryClientCapture = ({ onCapture, children }: { onCapture: (client: QueryClient) => void; children: ReactNode }) => {
  onCapture(useDashboardQueryClient());
  return <>{children}</>;
};

describe("Discord server panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("confirms an effective mapping preview before saving it", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(requestHref(input), window.location.origin);
      if (url.pathname.endsWith("/server") && (init?.method ?? "GET") === "GET") return json(server());
      if (url.pathname.endsWith("/settings") && (init?.method ?? "GET") === "GET") return json({ settings: { chatHintEnabled: true }, revision: 1 });
      if (url.pathname === "/api/csrf") return json({ token: "csrf-fictional" });
      if (url.pathname.endsWith("/server/mappings/preview")) return json({ gain: { count: 2, roleName: "Harbor VIP" }, lose: [] });
      if (url.pathname.endsWith("/server/mappings")) return json({ mappings: { vip: "990000000000000102", moderator: null } });
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();

    await screen.findByText("Amber Harbor");
    fireEvent.click(screen.getByRole("combobox", { name: "VIP role" }));
    clickSelectOption(await screen.findByRole("option", { name: "Harbor VIP", hidden: true }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(0) as HTMLButtonElement);

    expect(await screen.findByRole("heading", { name: "Confirm role changes" })).toBeInTheDocument();
    expect(screen.getByText(/2 will get Harbor VIP/)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => requestHref(input).includes("mappings/preview"))).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => requestHref(input).endsWith("/server/mappings"))).toBe(true));
  });

  it("keeps teardown state in the status slot and blocks role edits", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = new URL(requestHref(input), window.location.origin);
      return url.pathname.endsWith("/settings")
        ? json({ settings: { chatHintEnabled: true }, revision: 1 })
        : json(server({ teardown: true, teardownRemaining: 3 }));
    }));
    renderPanel();

    expect(await screen.findByText("Disabling, removing 3 roles")).toBeInTheDocument();
    expect(screen.getByLabelText("VIP role")).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Offer linking for a new rank" })).toBeDisabled();
  });

  it("saves the chat-hint switch explicitly", async () => {
    let currentSettings = { chatHintEnabled: true };
    let currentRevision = 1;
    const writes: Array<{ settings: { chatHintEnabled: boolean }; revision: number }> = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(requestHref(input), window.location.origin);
      if (url.pathname.endsWith("/server")) return json(server());
      if (url.pathname.endsWith("/settings") && (init?.method ?? "GET") === "GET") {
        return writes.length === 0 ? json({ settings: currentSettings, revision: currentRevision }) : json({ error: "status_unavailable" }, 503);
      }
      if (url.pathname === "/api/csrf") return json({ token: "csrf-fictional" });
      if (url.pathname.endsWith("/settings") && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as { settings: { chatHintEnabled: boolean }; revision: number };
        writes.push(body);
        if (body.revision !== currentRevision) return json({ error: "module_settings_changed_concurrently" }, 409);
        currentSettings = body.settings;
        currentRevision += 1;
        return json({ settings: currentSettings, revision: currentRevision });
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const captured: { client: QueryClient | null } = { client: null };
    render(<DashboardDataProvider><QueryClientCapture onCapture={(client) => { captured.client = client; }}>
      <DiscordServerPanel channelId="fictional-channel" language="en" canManage />
    </QueryClientCapture></DashboardDataProvider>);

    const hint = await screen.findByRole("switch", { name: "Offer linking for a new rank" });
    fireEvent.click(hint);
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons.at(-1) as HTMLButtonElement);

    expect(await screen.findByText("Chat hint saved.")).toBeInTheDocument();
    expect(hint).not.toBeChecked();
    expect(captured.client?.getQueryData(moduleQueryKey("fictional-channel", "discord", "settings"))).toEqual({
      settings: { chatHintEnabled: false },
      revision: 2,
    });
    fireEvent.click(hint);
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1) as HTMLButtonElement);

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(await screen.findByText("Chat hint saved.")).toBeInTheDocument();
    expect(writes.map(({ settings }) => settings.chatHintEnabled)).toEqual([false, true]);
    expect(writes.map(({ revision }) => revision)).toEqual([1, 2]);
    expect(hint).toBeChecked();
  });

  it("reloads the fixed status slot after a stale disconnect confirmation", async () => {
    let serverReads = 0;
    let disconnectBody: { guildId: string; connectedAt: string } | null = null;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = new URL(requestHref(input), window.location.origin);
      if (url.pathname.endsWith("/server")) {
        serverReads += 1;
        return json(server(serverReads === 1 ? {} : {
          connection: { channelId: "fictional-channel", guildId: "990000000000000101", connectedAt: "2026-11-24T11:00:00.000Z", connectedBy: "fictional-manager" },
          guildName: "Replacement Harbor",
        }));
      }
      if (url.pathname.endsWith("/settings")) return json({ settings: { chatHintEnabled: true }, revision: 1 });
      if (url.pathname === "/api/csrf") return json({ token: "csrf-fictional" });
      if (url.pathname.endsWith("/server/disconnect") && init?.method === "POST") {
        disconnectBody = JSON.parse(init.body as string) as { guildId: string; connectedAt: string };
        return json({ error: "discord_server_changed" }, 409);
      }
      throw new Error(`Unexpected request: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    renderPanel();

    await screen.findByText("Amber Harbor");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect server" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Disconnect server" }).at(-1) as HTMLButtonElement);

    expect(await screen.findByText("Server changed. Status reloaded.")).toBeInTheDocument();
    expect(disconnectBody).toEqual({ guildId: "990000000000000101", connectedAt: "2026-11-24T10:00:00.000Z" });
    expect(await screen.findByText("Replacement Harbor")).toBeInTheDocument();
  });
});
