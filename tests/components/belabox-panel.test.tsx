import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { renderWithQuery as render } from "../query-test-utils";
import BelaboxPanel from "../../src/modules/belabox/panel";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";

const mocks = vi.hoisted(() => ({
  loadBelaboxStatus: vi.fn(),
  retryBelaboxPolling: vi.fn(),
  removeBelaboxStatsUrl: vi.fn(),
  testBelaboxConnection: vi.fn(),
  loadBelaboxHistory: vi.fn(),
  loadBelaboxStreams: vi.fn(),
}));

const openRemoveAction = async () => {
  const menuButton = await screen.findByRole("button", { name: "More connection actions" });
  await waitFor(() => { expect(menuButton).toBeEnabled(); });
  fireEvent.click(menuButton);
  return screen.findByRole("menuitem", { name: "Remove stats URL" });
};

vi.mock("../../src/modules/belabox/panel/service", () => mocks);

describe("BELABOX panel", () => {
  beforeEach(() => {
    mocks.loadBelaboxStatus.mockReset().mockResolvedValue({
      configured: true,
      updatedAt: null,
      mode: "interval",
      sample: null,
      polling: false,
      pollingDesired: false,
      streamId: "stream-s2",
      belaboxStreamId: null,
    });
    mocks.retryBelaboxPolling.mockReset().mockResolvedValue(undefined);
    mocks.removeBelaboxStatsUrl.mockReset();
    mocks.testBelaboxConnection.mockReset();
    mocks.loadBelaboxHistory.mockReset().mockResolvedValue([]);
    mocks.loadBelaboxStreams.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setDashboardRealtimeStatus("kanal-a", "offline");
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.resetAllMocks();
  });

  it("shows a failed stats URL deletion inside its confirmation dialog", async () => {
    mocks.removeBelaboxStatsUrl.mockRejectedValue(new Error("D1 DELETE failed"));

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage settingsRevision={1} /></></UiProvider>);
    const removeButton = await openRemoveAction();
    await waitFor(() => { expect(removeButton).toBeEnabled(); });
    fireEvent.click(removeButton);

    const dialog = await screen.findByRole("dialog", { name: "Remove stats URL?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove stats URL" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent("The stats URL could not be removed.");
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Remove stats URL" })).toBeEnabled();
  });

  it("does not report an aborted status read as a connection failure", async () => {
    mocks.loadBelaboxStatus.mockImplementation((_channelId: string, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Request was aborted.", "AbortError")), { once: true });
    }));

    const view = render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);
    await waitFor(() => { expect(mocks.loadBelaboxStatus).toHaveBeenCalledOnce(); });
    view.unmount();

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(toastsSnapshot()).toHaveLength(0);
  });

  it("reflects a successful removal even when the status refresh fails", async () => {
    mocks.removeBelaboxStatsUrl.mockResolvedValue({ revision: 2 });

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage settingsRevision={1} /></></UiProvider>);
    const removeButton = await openRemoveAction();
    await waitFor(() => { expect(removeButton).toBeEnabled(); });
    fireEvent.click(removeButton);
    mocks.loadBelaboxStatus.mockRejectedValue(new Error("refresh failed"));

    const dialog = await screen.findByRole("dialog", { name: "Remove stats URL?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove stats URL" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The status could not be refreshed.");
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(screen.getByText("No stats URL stored")).toBeInTheDocument();
  });

  it("shows the inactive polling state and retries by ensuring the poll alarm", async () => {
    mocks.loadBelaboxStatus.mockResolvedValue({
      configured: true,
      updatedAt: null,
      mode: "interval",
      sample: null,
      polling: false,
      pollingDesired: true,
      intervalSeconds: 15,
      streamId: "stream-s2",
      belaboxStreamId: null,
    });

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="kanal-a" canManage /></></UiProvider>);

    expect(await screen.findByRole("alert")).toHaveTextContent("Abfrage nicht aktiv – erneut versuchen");
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    await waitFor(() => {
      expect(mocks.retryBelaboxPolling).toHaveBeenCalledOnce();
      expect(mocks.retryBelaboxPolling).toHaveBeenCalledWith("kanal-a");
    });
  });

  it("shows compact connection property rows before the test result is available", async () => {
    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    expect(await screen.findByText("Waiting for first sample")).toBeInTheDocument();
    expect(screen.queryByLabelText("Stats URL")).not.toBeInTheDocument();
    expect(screen.getByText("Changed")).toBeInTheDocument();
    expect(screen.getByText("Latest sample")).toBeInTheDocument();
    expect(screen.getByTestId("belabox-test-result-slot")).toBeInTheDocument();
  });

  it("explains that on-demand mode keeps the current sample without history", async () => {
    mocks.loadBelaboxStatus.mockResolvedValue({
      configured: true,
      updatedAt: null,
      mode: "on_demand",
      sample: { at: "2026-10-05T12:00:00.000Z", connected: true, bitrateKbps: 2_400, rttMs: 41,
        latencyMs: 115, network: 2, droppedPackets: 4 },
      errorCode: null,
      polling: false,
      pollingDesired: false,
      streamId: "stream-s2",
      belaboxStreamId: null,
    });

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    expect(await screen.findByText(/On-demand mode does not store history/)).toBeInTheDocument();
    expect(screen.getByText("Latest sample").parentElement).toHaveTextContent("2400 kbps");
    expect(mocks.loadBelaboxHistory).not.toHaveBeenCalled();
    expect(mocks.loadBelaboxStreams).not.toHaveBeenCalled();
  });

  it("refreshes status and history after the Belabox resource revision advances", async () => {
    mocks.loadBelaboxStatus
      .mockResolvedValueOnce({
        configured: true, updatedAt: null, mode: "on_demand", sample: null, errorCode: null,
        polling: false, pollingDesired: false, streamId: "stream-42", belaboxStreamId: null,
      })
      .mockResolvedValue({
        configured: true, updatedAt: null, mode: "interval", sample: null, errorCode: null,
        polling: true, pollingDesired: true, intervalSeconds: 15, streamId: "stream-42", belaboxStreamId: "stream-42",
      });
    let revision = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: { "module:belabox:live": revision } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }))));
    const view = render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    await waitFor(() => { expect(mocks.loadBelaboxStatus).toHaveBeenCalledOnce(); });
    expect(mocks.loadBelaboxHistory).not.toHaveBeenCalled();
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "channel-a"); });
    revision = 1;
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "channel-a"); });

    await waitFor(() => {
      expect(mocks.loadBelaboxStatus).toHaveBeenCalledTimes(2);
      expect(mocks.loadBelaboxHistory).toHaveBeenCalledWith("channel-a", "live", undefined, expect.any(AbortSignal));
    });
    expect(mocks.loadBelaboxStreams).toHaveBeenCalledOnce();
    // A status without a finite intervalSeconds makes the refresh timer fire continuously.
    expect(mocks.loadBelaboxStatus).toHaveBeenCalledTimes(2);
  });

  it("notifies once for each Belabox status outage, including after an identical recovery", async () => {
    setDashboardRealtimeStatus("kanal-a", "connected");
    const view = render(<UiProvider><><ToastHost /><BelaboxPanel channelId="kanal-a" language="en" canManage /></></UiProvider>);
    await waitFor(() => { expect(mocks.loadBelaboxStatus).toHaveBeenCalledOnce(); });
    const key = { queryKey: moduleQueryKey("kanal-a", "belabox", "status"), exact: true };
    const refresh = async (): Promise<void> => {
      await act(async () => { await view.queryClient.refetchQueries(key, { throwOnError: true }).catch(() => undefined); });
    };

    mocks.loadBelaboxStatus.mockRejectedValue(new Error("status unavailable"));
    await refresh();
    await refresh();
    expect(toastsSnapshot().filter((toast) => toast.message === "The connection could not be tested.")).toHaveLength(1);

    mocks.loadBelaboxStatus.mockResolvedValue({
      configured: true, updatedAt: null, mode: "interval", sample: null, errorCode: null,
      polling: false, pollingDesired: false, streamId: "stream-s2", belaboxStreamId: null,
    });
    await refresh();
    mocks.loadBelaboxStatus.mockRejectedValue(new Error("status unavailable again"));
    await refresh();
    expect(toastsSnapshot().filter((toast) => toast.message === "The connection could not be tested.")).toHaveLength(2);
  });

  it("does not report a failed connection when the status request is aborted on unmount", async () => {
    let statusSignal: AbortSignal | undefined;
    mocks.loadBelaboxStatus.mockImplementation((_channelId: string, signal: AbortSignal) => {
      statusSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    });

    const view = render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);
    await waitFor(() => { expect(mocks.loadBelaboxStatus).toHaveBeenCalledOnce(); });
    view.unmount();
    await waitFor(() => { expect(statusSignal?.aborted).toBe(true); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(toastsSnapshot().filter((toast) => toast.message === "The connection could not be tested.")).toHaveLength(0);
  });

  it("draws the history thresholds and disconnect gaps and can select a stream", async () => {
    mocks.loadBelaboxStatus.mockResolvedValue({
      configured: true,
      updatedAt: null,
      mode: "interval",
      sample: null,
      errorCode: null,
      polling: true,
      pollingDesired: true,
      intervalSeconds: 15,
      streamId: "stream-42",
      belaboxStreamId: "stream-42",
    });
    mocks.loadBelaboxHistory.mockResolvedValue([
      [Date.parse("2026-10-05T12:00:00.000Z"), 2_400, 1],
      [Date.parse("2026-10-05T12:00:15.000Z"), 0, 0],
    ]);
    mocks.loadBelaboxStreams.mockResolvedValue([{
      streamId: "stream-42",
      startedAt: "2026-10-05T12:00:00.000Z",
      endedAt: null,
      samples: 2,
      bitrateAvg: 1_200,
      bitrateP10: 0,
      lowSeconds: 0,
      disconnectedSeconds: 0,
      disconnectCount: 1,
      droppedTotal: 3,
    }]);

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    const chart = await screen.findByRole("img", { name: "Bitrate history" });
    await waitFor(() => {
      expect(chart.querySelectorAll('line[stroke-dasharray]')).toHaveLength(2);
      expect(chart.querySelectorAll("rect")).toHaveLength(1);
    });
    expect(await screen.findByText(/Average 1200/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stream" }));
    await waitFor(() => {
      expect(mocks.loadBelaboxHistory).toHaveBeenCalledWith("channel-a", "stream", "stream-42", expect.any(AbortSignal));
    });
  });

  it("uses the saved bitrate thresholds for chart lines and labels", async () => {
    mocks.loadBelaboxStatus.mockResolvedValue({
      configured: true,
      updatedAt: null,
      mode: "interval",
      sample: null,
      errorCode: null,
      polling: true,
      pollingDesired: true,
      intervalSeconds: 15,
      streamId: "stream-42",
      belaboxStreamId: "stream-42",
    });

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage lowBitrateKbps={700} recoverBitrateKbps={3_500} /></></UiProvider>);

    const chart = await screen.findByRole("img", { name: "Bitrate history" });
    const historySection = chart.closest("section[aria-label='Bitrate history']");
    expect(historySection).not.toBeNull();
    await waitFor(() => {
      expect(historySection).toHaveTextContent("Low threshold: 700 kbps");
      expect(historySection).toHaveTextContent("Recovery threshold: 3,500 kbps");
    });
    const thresholdLines = chart.querySelectorAll('line[stroke-dasharray]');
    expect(Number(thresholdLines[0]?.getAttribute("y1"))).toBeCloseTo(142.9, 1);
    expect(Number(thresholdLines[1]?.getAttribute("y1"))).toBeCloseTo(26.5, 1);
  });

  it("caps the stream history at twenty rows inside a bounded scroll region", async () => {
    mocks.loadBelaboxStreams.mockResolvedValue(Array.from({ length: 25 }, (_, index) => ({
      streamId: `stream-${String(index)}`,
      startedAt: new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000).toISOString(),
      endedAt: null,
      samples: 1,
      bitrateAvg: 2_400,
      bitrateP10: 2_100,
      lowSeconds: 0,
      disconnectedSeconds: 0,
      disconnectCount: 0,
      droppedTotal: 0,
    })));

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    const list = await screen.findByTestId("belabox-stream-history-list");
    await waitFor(() => { expect(within(list).getAllByRole("button")).toHaveLength(20); });
    expect(list).toHaveStyle({ maxHeight: "320px", overflowY: "auto" });
  });
});
