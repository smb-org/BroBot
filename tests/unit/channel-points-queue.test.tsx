import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelPointsQueueItem } from "../../src/modules/channel_points/contracts";
import ChannelPointsQueueActionContent from "../../src/modules/channel_points/panel/queue-action-content";
import { UiProvider } from "../../src/dashboard/ui";
import { dismissToastsForScope, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ImmediateActions } from "../../src/dashboard/ImmediateActions";

vi.mock("../../src/dashboard/data/realtime", () => ({
  useDashboardRealtimeStatus: () => "disconnected",
}));

const channelId = "fictional_channel_points_channel";
const makeQueueItem = (redemptionId: string, redeemedAt: string, userName: string): ChannelPointsQueueItem => ({
  redemptionId,
  rewardId: "reward_local",
  twitchRewardId: "reward_twitch",
  rewardTitle: "Fictional reward",
  userId: `user_${redemptionId}`,
  userLogin: userName.toLowerCase().replaceAll(" ", "_"),
  userName,
  userInput: "A long viewer request that should stay on one line in the queue",
  redeemedAt,
  status: "queued",
  pendingTwitchStatus: null,
  outcomeReason: null,
  createdAt: redeemedAt,
  updatedAt: redeemedAt,
  actionName: { de: "Chat-Nachricht", en: "Chat message" },
});

const earlyItem = makeQueueItem("redemption_early", "2030-01-01T10:00:00.000Z", "Viewer Early");
const lateItem = makeQueueItem("redemption_late", "2030-01-01T11:00:00.000Z", "Viewer Late");

const jsonResponse = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), {
  status,
  headers: { "Content-Type": "application/json" },
});

const renderQueueContent = (canOperate = true) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<UiProvider><QueryClientProvider client={queryClient}>
    <ChannelPointsQueueActionContent channelId={channelId} language="de" canOperate={canOperate} />
  </QueryClientProvider></UiProvider>);
  return { ...result, queryClient };
};

describe("channel-points cockpit queue", () => {
  beforeEach(() => {
    dismissToastsForScope("channel-points-queue");
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.endsWith("/queue")) return jsonResponse({ items: [lateItem, earlyItem] });
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the cockpit action only when queued redemptions exist", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<UiProvider><QueryClientProvider client={queryClient}>
      <ImmediateActions
        channelId={channelId}
        role="operator"
        modules={[{ id: "channel_points", enabled: true }]}
      />
    </QueryClientProvider></UiProvider>);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Kanalpunkte-Warteschlange" })).not.toBeInTheDocument());
    queryClient.clear();
  });

  it("shows the cockpit action when the queue contains a redemption", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ items: [earlyItem] }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<UiProvider><QueryClientProvider client={queryClient}>
      <ImmediateActions
        channelId={channelId}
        role="operator"
        modules={[{ id: "channel_points", enabled: true }]}
      />
    </QueryClientProvider></UiProvider>);

    expect(await screen.findByRole("button", { name: "Kanalpunkte-Warteschlange" })).toBeVisible();
    queryClient.clear();
  });

  it("hides the cockpit action while the module is disabled", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<UiProvider><QueryClientProvider client={queryClient}>
      <ImmediateActions
        channelId={channelId}
        role="operator"
        modules={[{ id: "channel_points", enabled: false }]}
      />
    </QueryClientProvider></UiProvider>);

    expect(screen.queryByRole("button", { name: "Kanalpunkte-Warteschlange" })).not.toBeInTheDocument();
    queryClient.clear();
  });

  it("renders queued items oldest first", async () => {
    renderQueueContent();

    const rows = await screen.findAllByRole("article");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["Viewer Early", "Viewer Late"]);
    expect(within(rows[0] as HTMLElement).getByText("Viewer Early")).toBeInTheDocument();
  });

  it("keeps queue rows readable without action buttons for a read-only viewer", async () => {
    renderQueueContent(false);

    const row = await screen.findByRole("article", { name: "Viewer Early" });
    expect(within(row).getByText("Viewer Early")).toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Ausführen" })).not.toBeInTheDocument();
    expect(within(row).queryByRole("button", { name: "Erstatten" })).not.toBeInTheDocument();
  });

  it("marks only the selected row pending and removes it after a successful run", async () => {
    let queued = [lateItem, earlyItem];
    let resolveRun: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/queue")) return jsonResponse({ items: queued });
      if (url === "/api/csrf") return jsonResponse({ token: "csrf-fixture" });
      if (url.endsWith("/redemption_early/run") && init?.method === "POST") {
        return await new Promise<Response>((resolve) => { resolveRun = resolve; });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    renderQueueContent();

    const earlyRow = await screen.findByRole("article", { name: "Viewer Early" });
    const lateRow = screen.getByRole("article", { name: "Viewer Late" });
    fireEvent.click(within(earlyRow).getByRole("button", { name: "Ausführen" }));

    await waitFor(() => expect(earlyRow).toHaveAttribute("aria-busy", "true"));
    expect(within(earlyRow).getByRole("button", { name: "Ausführen" })).toBeDisabled();
    expect(within(earlyRow).getByRole("button", { name: "Erstatten" })).toBeDisabled();
    expect(within(lateRow).getByRole("button", { name: "Ausführen" })).toBeEnabled();
    expect(resolveRun).toBeDefined();

    queued = [lateItem];
    act(() => { resolveRun?.(jsonResponse({ ok: true, status: "fulfilled" })); });
    await waitFor(() => expect(screen.queryByRole("article", { name: "Viewer Early" })).not.toBeInTheDocument());
    expect(screen.getByRole("article", { name: "Viewer Late" })).toBeInTheDocument();
  });

  it("maps a stale queue claim to a localized error toast", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/queue")) return jsonResponse({ items: [earlyItem] });
      if (url === "/api/csrf") return jsonResponse({ token: "csrf-fixture" });
      if (url.endsWith("/redemption_early/run") && init?.method === "POST") {
        return jsonResponse({ error: "channel_points_redemption_not_queued", status: "fulfilled" }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderQueueContent();

    const row = await screen.findByRole("article", { name: "Viewer Early" });
    fireEvent.click(within(row).getByRole("button", { name: "Ausführen" }));

    await waitFor(() => expect(toastsSnapshot().at(-1)?.message).toBe("Diese Einlösung wurde bereits verarbeitet."));
  });

  it("maps a Twitch-resolved redemption to a localized error toast", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/queue")) return jsonResponse({ items: [earlyItem] });
      if (url === "/api/csrf") return jsonResponse({ token: "csrf-fixture" });
      if (url.endsWith("/redemption_early/run") && init?.method === "POST") {
        return jsonResponse({ error: "channel_points_already_resolved_on_twitch", status: "refunded" }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderQueueContent();

    const row = await screen.findByRole("article", { name: "Viewer Early" });
    fireEvent.click(within(row).getByRole("button", { name: "Ausführen" }));

    await waitFor(() => expect(toastsSnapshot().at(-1)?.message)
      .toBe("Diese Einlösung wurde auf Twitch bereits verarbeitet."));
  });
});
