import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PanelChannelLocation } from "../../src/panel-contract";
import { ChannelLocationMenu } from "../../src/dashboard/ui/ChannelLocationMenu";
import { UiProvider } from "../../src/dashboard/ui";

const location: PanelChannelLocation = {
  name: "Regensburg",
  latitude: 49.01,
  longitude: 12.1,
  timeZone: "Europe/Berlin",
};

const messages = {
  openIn: "Open in",
  openStreetMap: "OpenStreetMap",
  googleMaps: "Google Maps",
  appleMaps: "Apple Maps",
  copyCoordinates: "Copy coordinates",
  coordinatesCopied: "Coordinates copied",
  copyCoordinatesFailed: "Coordinates could not be copied",
};

let originalClipboard: PropertyDescriptor | undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalClipboard === undefined) Reflect.deleteProperty(navigator, "clipboard");
  else Object.defineProperty(navigator, "clipboard", originalClipboard);
  originalClipboard = undefined;
});

describe("ChannelLocationMenu", () => {
  it("shows external map targets in order and copies coordinates accessibly", async () => {
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<UiProvider><ChannelLocationMenu location={location} messages={messages} /></UiProvider>);

    const trigger = screen.getByRole("button", { name: "Regensburg" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("title", "Regensburg");
    expect(trigger).toHaveTextContent("Regensburg · 49.01, 12.10");
    fireEvent.click(trigger);

    const openStreetMap = await screen.findByRole("menuitem", { name: "OpenStreetMap", hidden: true });
    const googleMaps = await screen.findByRole("menuitem", { name: "Google Maps", hidden: true });
    const appleMaps = await screen.findByRole("menuitem", { name: "Apple Maps", hidden: true });
    expect(openStreetMap).toHaveAttribute("href", "https://www.openstreetmap.org/?mlat=49.01&mlon=12.1#map=12/49.01/12.1");
    expect(openStreetMap).toHaveAttribute("target", "_blank");
    expect(openStreetMap).toHaveAttribute("rel", "noopener noreferrer");
    expect(googleMaps).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=49.01,12.1");
    expect(appleMaps).toHaveAttribute("href", "https://maps.apple.com/?ll=49.01,12.1&q=Regensburg");
    expect([openStreetMap.textContent, googleMaps.textContent, appleMaps.textContent]).toEqual([
      "OpenStreetMap", "Google Maps", "Apple Maps",
    ]);

    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy coordinates", hidden: true }));
    expect(writeText).toHaveBeenCalledWith("49.0100, 12.1000");
    expect(await screen.findByRole("status")).toHaveTextContent("Coordinates copied");
  });

  it("shows only the first name segment in the header while keeping the full name accessible", async () => {
    const longName: PanelChannelLocation = { ...location, name: "Stuttgart, Baden-Württemberg, Deutschland" };
    render(<UiProvider><ChannelLocationMenu location={longName} messages={messages} /></UiProvider>);

    const trigger = screen.getByRole("button", { name: "Stuttgart, Baden-Württemberg, Deutschland" });
    expect(trigger).toHaveAttribute("title", "Stuttgart, Baden-Württemberg, Deutschland");
    expect(trigger).toHaveTextContent("Stuttgart · 49.01, 12.10");
    expect(trigger).not.toHaveTextContent("Baden-Württemberg");

    fireEvent.click(trigger);
    expect(await screen.findByText("Stuttgart, Baden-Württemberg, Deutschland")).toBeInTheDocument();
  });

  it("uses the full name as the short name when it has no comma-separated segments", () => {
    const plainName: PanelChannelLocation = { ...location, name: "Regensburg" };
    render(<UiProvider><ChannelLocationMenu location={plainName} messages={messages} /></UiProvider>);

    expect(screen.getByRole("button", { name: "Regensburg" })).toHaveTextContent("Regensburg · 49.01, 12.10");
  });
});
