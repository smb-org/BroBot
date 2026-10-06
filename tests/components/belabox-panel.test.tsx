import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import BelaboxPanel from "../../src/modules/belabox/panel";

const mocks = vi.hoisted(() => ({
  loadBelaboxStatus: vi.fn(),
  retryBelaboxPolling: vi.fn(),
  removeBelaboxStatsUrl: vi.fn(),
  replaceBelaboxStatsUrl: vi.fn(),
  testBelaboxConnection: vi.fn(),
  loadBelaboxHistory: vi.fn(),
  loadBelaboxStreams: vi.fn(),
}));

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
    mocks.replaceBelaboxStatsUrl.mockReset();
    mocks.testBelaboxConnection.mockReset();
    mocks.loadBelaboxHistory.mockReset().mockResolvedValue([]);
    mocks.loadBelaboxStreams.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.resetAllMocks();
  });

  it("shows a failed stats URL deletion inside its confirmation dialog", async () => {
    mocks.removeBelaboxStatsUrl.mockRejectedValue(new Error("D1 DELETE failed"));

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Remove stats URL" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove stats URL?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove stats URL" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent("The stats URL could not be removed.");
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Remove stats URL" })).toBeEnabled();
  });

  it("reflects a successful removal even when the status refresh fails", async () => {
    mocks.removeBelaboxStatsUrl.mockResolvedValue(undefined);

    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Remove stats URL" }));
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

  it("reserves the test result and live status rows before values are available", async () => {
    render(<UiProvider><><ToastHost /><BelaboxPanel channelId="channel-a" language="en" canManage /></></UiProvider>);

    expect(await screen.findByText("Stats URL stored")).toBeInTheDocument();
    expect(screen.getByTestId("belabox-updated-at-slot")).toBeInTheDocument();
    expect(screen.getByTestId("belabox-sample-slot")).toBeInTheDocument();
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
    expect(screen.getByTestId("belabox-sample-slot")).toHaveTextContent("2400 kbps");
    expect(mocks.loadBelaboxHistory).not.toHaveBeenCalled();
    expect(mocks.loadBelaboxStreams).not.toHaveBeenCalled();
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
      expect(mocks.loadBelaboxHistory).toHaveBeenCalledWith("channel-a", "stream", "stream-42");
    });
  });
});
