import type { ReactElement } from "react";

import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BelaboxStatusResponse } from "../../src/modules/belabox/contracts";
import BelaboxPanel from "../../src/modules/belabox/panel/index";
import BelaboxStatusAction from "../../src/modules/belabox/panel/immediate-actions";
import { UiProvider } from "../../src/dashboard/ui";
import { invalidateDashboardRealtimeMessage } from "../../src/dashboard/data/realtime";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { renderWithQuery as render } from "../query-test-utils";

const status: BelaboxStatusResponse = {
  configured: true,
  updatedAt: null,
  mode: "on_demand",
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
    vi.useRealTimers();
  });

  it("shows the alert notice and Check now action in the module page reserved slot", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status))));
    renderWithUi(<BelaboxPanel channelId="channel-a" language="en" canManage />);

    const notice = await screen.findByText(/BELABOX encoder disconnected/u);
    expect(notice).toHaveTextContent("BELABOX encoder disconnected");
    expect(screen.getByRole("button", { name: /Check now|Jetzt prüfen/u })).toBeEnabled();
  });

  it("shows the same current-stream alert in the lazy immediate-action card", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status))));
    renderWithUi(<BelaboxStatusAction channelId="channel-a" canManage availabilityReason={null} />);

    expect(await screen.findByText(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check now|Jetzt prüfen/u })).toBeEnabled();
  });

  it("reloads status when stream availability changes from offline to live", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(status)));
    vi.stubGlobal("fetch", fetcher);
    const view = renderWithUi(<BelaboxStatusAction channelId="channel-a" canManage availabilityReason="Stream is offline." />);

    expect(await screen.findByTestId("belabox-immediate-status-slot")).toHaveTextContent("Stream is offline.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(<UiProvider><BelaboxStatusAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);
    invalidateDashboardRealtimeMessage(view.queryClient, {
      version: 1,
      id: "stream-now-live",
      createdAt: new Date().toISOString(),
      channelId: "channel-a",
      type: "stream.state.changed",
      payload: { state: "online", startedAt: new Date().toISOString(), changedAt: new Date().toISOString() },
    } satisfies RealtimeMessage);

    await waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
    expect(await screen.findByTestId("belabox-immediate-status-slot")).toHaveTextContent(/BELABOX encoder disconnected|BELABOX-Encoder getrennt/u);
  });

});
