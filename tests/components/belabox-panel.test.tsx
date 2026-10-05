import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import BelaboxPanel from "../../src/modules/belabox/panel";
import { UiProvider } from "../../src/dashboard/ui";

const belaboxServices = vi.hoisted(() => ({
  loadBelaboxStatus: vi.fn(),
  removeBelaboxStatsUrl: vi.fn(),
  replaceBelaboxStatsUrl: vi.fn(),
  testBelaboxConnection: vi.fn(),
}));

vi.mock("../../src/modules/belabox/panel/service", () => belaboxServices);

describe("BELABOX panel", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("shows a failed stats URL deletion inside its confirmation dialog", async () => {
    belaboxServices.loadBelaboxStatus.mockResolvedValue({ configured: true, updatedAt: null, sample: null });
    belaboxServices.removeBelaboxStatsUrl.mockRejectedValue(new Error("D1 DELETE failed"));

    render(<UiProvider><BelaboxPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Remove stats URL" }));

    const dialog = await screen.findByRole("dialog", { name: "Remove stats URL?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove stats URL" }));

    await waitFor(() => {
      expect(within(dialog).getByRole("alert")).toHaveTextContent("The stats URL could not be removed.");
    });
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "Remove stats URL" })).toBeEnabled();
  });

  it("reflects a successful removal on the page even when the status refresh fails", async () => {
    belaboxServices.loadBelaboxStatus.mockResolvedValueOnce({ configured: true, updatedAt: null, sample: null });
    belaboxServices.removeBelaboxStatsUrl.mockResolvedValue(undefined);

    render(<UiProvider><BelaboxPanel channelId="channel-a" language="en" canManage /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Remove stats URL" }));
    belaboxServices.loadBelaboxStatus.mockRejectedValue(new Error("refresh failed"));

    const dialog = await screen.findByRole("dialog", { name: "Remove stats URL?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove stats URL" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The status could not be refreshed.");
    await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
    expect(screen.getByText("No stats URL stored")).toBeInTheDocument();
  });
});
