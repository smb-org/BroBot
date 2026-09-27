import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelChannelLocationResult } from "../../src/dashboard/api";
import { ChannelLocationField } from "../../src/dashboard/ChannelLocationField";
import { UiProvider } from "../../src/dashboard/ui";

const api = vi.hoisted(() => ({
  saveChannelLocation: vi.fn(),
  searchChannelLocations: vi.fn(),
}));

vi.mock("../../src/dashboard/api", () => ({
  saveChannelLocation: api.saveChannelLocation,
  searchChannelLocations: api.searchChannelLocations,
}));

afterEach(() => vi.clearAllMocks());

describe("ChannelLocationField", () => {
  it("shows an explicit time zone action after a location is chosen", async () => {
    const location: PanelChannelLocationResult = {
      name: "Tromsø",
      admin1: "Troms og Finnmark",
      country: "Norway",
      latitude: 69.6492,
      longitude: 18.9553,
      timeZone: "Europe/Oslo",
    };
    api.searchChannelLocations.mockResolvedValue([location]);
    api.saveChannelLocation.mockResolvedValue({ ok: true, location, locationRevision: 2 });
    const onSaveChannelTimeZone = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();

    render(<UiProvider><ChannelLocationField
      channelId="channel-a"
      language="en"
      value={null}
      revision={1}
      onSaved={onSaved}
      channelTimeZone="Europe/Berlin"
      onSaveChannelTimeZone={onSaveChannelTimeZone}
      canEdit
      disabled={false}
    /></UiProvider>);

    fireEvent.change(screen.getByRole("textbox", { name: "Search for a place" }), { target: { value: "Tromsø" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "Select" }));

    expect(await screen.findByText("Set channel time zone to Europe/Oslo?")).toBeInTheDocument();
    expect(onSaveChannelTimeZone).not.toHaveBeenCalled();
    expect(api.saveChannelLocation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Apply time zone" }));
    expect(onSaveChannelTimeZone).toHaveBeenCalledWith("Europe/Oslo");
    expect(await screen.findByText("Channel time zone updated.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save location" }));
    expect(api.saveChannelLocation).toHaveBeenCalledWith("channel-a", 1, {
      name: "Tromsø, Troms og Finnmark, Norway",
      latitude: 69.6492,
      longitude: 18.9553,
      timeZone: "Europe/Oslo",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ timeZone: "Europe/Oslo" }), 2));
  });
});
