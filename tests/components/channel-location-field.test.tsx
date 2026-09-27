import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelChannelLocation, PanelChannelLocationResult } from "../../src/dashboard/api";
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChannelLocationField", () => {
  it("saves a chosen location immediately and keeps the time zone suggestion", async () => {
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

    function Harness() {
      const [value, setValue] = useState<PanelChannelLocation | null>(null);
      return <ChannelLocationField
        channelId="channel-a"
        language="en"
        value={value}
        revision={1}
        onSaved={(next, revision) => { onSaved(next, revision); setValue(next); }}
        channelTimeZone="Europe/Berlin"
        onSaveChannelTimeZone={onSaveChannelTimeZone}
        canEdit
        disabled={false}
      />;
    }
    render(<UiProvider><Harness /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    expect(await screen.findByRole("link", { name: "Location search by Open-Meteo.com" })).toHaveAttribute("href", "https://open-meteo.com/");
    fireEvent.change(await screen.findByRole("textbox", { name: "Search for a place" }), { target: { value: "Tromsø" } });
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("option", { name: /Tromsø/u }));

    expect(await screen.findByText("Set channel time zone to Europe/Oslo?")).toBeInTheDocument();
    expect(onSaveChannelTimeZone).not.toHaveBeenCalled();
    expect(api.saveChannelLocation).toHaveBeenCalledWith("channel-a", 1, {
      name: "Tromsø, Troms og Finnmark, Norway",
      latitude: 69.6492,
      longitude: 18.9553,
      timeZone: "Europe/Oslo",
    });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ timeZone: "Europe/Oslo" }), 2));

    fireEvent.click(screen.getByRole("button", { name: "Apply time zone" }));
    expect(onSaveChannelTimeZone).toHaveBeenCalledWith("Europe/Oslo");
    expect(await screen.findByText("Channel time zone updated.")).toBeInTheDocument();
  });

  it("shows a failed search inside the open dialog, not hidden behind it", async () => {
    api.searchChannelLocations.mockRejectedValue(new Error("boom"));

    function Harness() {
      const [value, setValue] = useState<PanelChannelLocation | null>(null);
      return <ChannelLocationField
        channelId="channel-a"
        language="en"
        value={value}
        revision={1}
        onSaved={(next) => setValue(next)}
        channelTimeZone="Europe/Berlin"
        onSaveChannelTimeZone={vi.fn()}
        canEdit
        disabled={false}
      />;
    }
    render(<UiProvider><Harness /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search for a place" }), { target: { value: "Tromsø" } });
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));

    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Locations could not be searched.");
    expect(screen.queryByText("No matching locations found.")).not.toBeInTheDocument();
  });

  it("shows a failed save inside the open dialog and leaves no stale preview for the next attempt", async () => {
    const location: PanelChannelLocationResult = {
      name: "Tromsø",
      admin1: "Troms og Finnmark",
      country: "Norway",
      latitude: 69.6492,
      longitude: 18.9553,
      timeZone: "Europe/Oslo",
    };
    api.searchChannelLocations.mockResolvedValue([location]);
    api.saveChannelLocation.mockRejectedValue(new Error("boom"));

    function Harness() {
      const [value, setValue] = useState<PanelChannelLocation | null>(null);
      return <ChannelLocationField
        channelId="channel-a"
        language="en"
        value={value}
        revision={1}
        onSaved={(next) => setValue(next)}
        channelTimeZone="Europe/Berlin"
        onSaveChannelTimeZone={vi.fn()}
        canEdit
        disabled={false}
      />;
    }
    render(<UiProvider><Harness /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Change location" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search for a place" }), { target: { value: "Tromsø" } });
    fireEvent.click(await screen.findByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("option", { name: /Tromsø/u }));

    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Location could not be saved.");
    expect(within(dialog).getByRole("textbox", { name: "Search for a place" })).toBeInTheDocument();
  });
});
