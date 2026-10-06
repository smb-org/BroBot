import type { ReactElement } from "react";

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BelaboxStatusResponse } from "../../src/modules/belabox/contracts";
import BelaboxPanel from "../../src/modules/belabox/panel/index";
import BelaboxStatusAction from "../../src/modules/belabox/panel/immediate-actions";
import { UiProvider } from "../../src/dashboard/ui";

const status: BelaboxStatusResponse = {
  configured: true,
  updatedAt: null,
  sample: { at: "2026-10-05T12:00:00.000Z", connected: false, bitrateKbps: 0, rttMs: 0, latencyMs: 0, network: 0, droppedPackets: 0 },
  errorCode: null,
  polling: true,
  pollingDesired: true,
  streamId: "stream-323",
  belaboxStreamId: "stream-323",
  alertNotice: { phase: "alarm", kind: "disconnect", bitrateKbps: 0 },
  fetchFailureNotice: false,
  intervalSeconds: 15,
};

const renderWithUi = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);

describe("BELABOX alert surfaces", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the alert notice and Check now action in the module page reserved slot", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status))));
    renderWithUi(<BelaboxPanel channelId="channel-a" language="en" canManage />);

    const notice = await screen.findByTestId("belabox-alert-notice-slot");
    expect(notice).toHaveTextContent("BELABOX encoder disconnected");
    expect(screen.getByRole("button", { name: /Check now|Jetzt prüfen/u })).toBeEnabled();
  });

  it("shows the same current-stream alert in the lazy immediate-action card", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status))));
    renderWithUi(<BelaboxStatusAction channelId="channel-a" canManage availabilityReason={null} />);

    expect(await screen.findByTestId("belabox-immediate-status-slot")).toHaveTextContent(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u);
    expect(screen.getByRole("button", { name: /Check now|Jetzt prüfen/u })).toBeEnabled();
  });

  it("reloads status when stream availability changes from offline to live", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status)));
    vi.stubGlobal("fetch", fetcher);
    const view = renderWithUi(<BelaboxStatusAction channelId="channel-a" canManage availabilityReason="Stream is offline." />);

    expect(await screen.findByTestId("belabox-immediate-status-slot")).toHaveTextContent("Stream is offline.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(<UiProvider><BelaboxStatusAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);

    await waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
    expect(await screen.findByTestId("belabox-immediate-status-slot")).toHaveTextContent(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u);
  });

  it("refreshes an offline-open module page until a live disconnect notice appears", async () => {
    const offlineStatus: BelaboxStatusResponse = {
      ...status,
      sample: null,
      polling: false,
      pollingDesired: false,
      streamId: null,
      belaboxStreamId: null,
      alertNotice: null,
    };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(offlineStatus))
      .mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetcher);
    vi.useFakeTimers();
    renderWithUi(<BelaboxPanel channelId="channel-a" language="en" canManage />);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    const notice = screen.getByTestId("belabox-alert-notice-slot");
    expect(notice).not.toHaveTextContent("BELABOX encoder disconnected");
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(notice).toHaveTextContent("BELABOX encoder disconnected");
  });

  it("retries a failed initial action-card status request and then starts refreshing", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(Response.json(status));
    vi.stubGlobal("fetch", fetcher);
    vi.useFakeTimers();
    try {
      renderWithUi(<BelaboxStatusAction channelId="channel-a" canManage availabilityReason={null} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("belabox-immediate-status-slot")).toHaveTextContent(/not available yet|noch nicht verfügbar/u);
      expect(screen.getByRole("button", { name: /Check now|Jetzt prüfen/u })).toBeEnabled();

      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("belabox-immediate-status-slot")).toHaveTextContent(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u);

      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
