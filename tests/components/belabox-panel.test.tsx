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
}));

vi.mock("../../src/modules/belabox/panel/service", () => mocks);

describe("BELABOX panel", () => {
  beforeEach(() => {
    mocks.loadBelaboxStatus.mockReset().mockResolvedValue({
      configured: true,
      updatedAt: null,
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
});
