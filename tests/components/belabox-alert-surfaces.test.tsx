import type { ReactElement } from "react";

import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BelaboxStatusResponse } from "../../src/modules/belabox/contracts";
import BelaboxPanel from "../../src/modules/belabox/panel/index";
import { UiProvider } from "../../src/dashboard/ui";
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

});
