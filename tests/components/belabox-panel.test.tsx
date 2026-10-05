import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadBelaboxStatus: vi.fn(),
  retryBelaboxPolling: vi.fn(),
  removeBelaboxStatsUrl: vi.fn(),
  replaceBelaboxStatsUrl: vi.fn(),
  testBelaboxConnection: vi.fn(),
}));

vi.mock("../../src/modules/belabox/panel/service", () => mocks);

import { UiProvider } from "../../src/dashboard/ui";
import BelaboxPanel from "../../src/modules/belabox/panel";

describe("BELABOX panel polling recovery", () => {
  beforeEach(() => {
    mocks.loadBelaboxStatus.mockReset().mockResolvedValue({
      configured: true,
      updatedAt: null,
      sample: null,
      errorCode: null,
      polling: false,
      pollingDesired: true,
      streamId: "stream-s2",
      belaboxStreamId: null,
    });
    mocks.retryBelaboxPolling.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => { cleanup(); });

  it("shows the inactive polling state and retries by ensuring the poll alarm", async () => {
    render(<UiProvider><BelaboxPanel channelId="kanal-a" canManage /></UiProvider>);

    expect(await screen.findByText("Abfrage nicht aktiv – erneut versuchen")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    await waitFor(() => {
      expect(mocks.retryBelaboxPolling).toHaveBeenCalledOnce();
      expect(mocks.retryBelaboxPolling).toHaveBeenCalledWith("kanal-a");
    });
  });
});
