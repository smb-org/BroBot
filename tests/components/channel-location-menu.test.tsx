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
  locationFallback: "Location",
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

    const trigger = screen.getByRole("button", { name: /Regensburg/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("title", "Regensburg");
    expect(trigger).toHaveTextContent("Regensburg");
    expect(trigger).not.toHaveTextContent("49.01, 12.10");
    fireEvent.click(trigger);
    expect(await screen.findByText("49.01, 12.10")).toBeInTheDocument();

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

    // Accessible name starts with the visible label (WCAG 2.5.3): matching
    // it against a leading "Stuttgart" pattern finds the button at all,
    // and a trailing full-name pattern confirms the full name is folded in
    // afterwards, via a visually hidden suffix.
    const trigger = screen.getByRole("button", { name: /^Stuttgart/ });
    expect(trigger).toHaveAttribute("title", "Stuttgart, Baden-Württemberg, Deutschland");
    expect(trigger).toHaveTextContent("Stuttgart");
    expect(trigger).not.toHaveTextContent("49.01, 12.10");
    expect(trigger.querySelector(".dashboard-header__location-label")).not.toHaveTextContent("Baden-Württemberg");
    expect(screen.getByRole("button", { name: /Baden-Württemberg, Deutschland$/ })).toBe(trigger);

    fireEvent.click(trigger);
    expect(await screen.findByText("Stuttgart, Baden-Württemberg, Deutschland")).toBeInTheDocument();
  });

  it("uses the full name as the short name when it has no comma-separated segments", () => {
    const plainName: PanelChannelLocation = { ...location, name: "Regensburg" };
    render(<UiProvider><ChannelLocationMenu location={plainName} messages={messages} /></UiProvider>);

    expect(screen.getByRole("button", { name: /Regensburg/ })).toHaveTextContent("Regensburg");
  });

  it("keeps coordinate-only location details behind an icon-only header control", async () => {
    render(<UiProvider><ChannelLocationMenu location={{ ...location, name: "49.01, 12.10" }} messages={messages} /></UiProvider>);

    const trigger = screen.getByRole("button", { name: "Location, 49.01, 12.10" });
    expect(trigger).toHaveClass("dashboard-header__location--icon-only");
    expect(trigger).toHaveAttribute("title", "49.01, 12.10");
    expect(trigger).not.toHaveTextContent("Location");
    expect(trigger).not.toHaveTextContent("49.01, 12.10");
    expect(trigger.querySelector(".lucide-map-pin")).not.toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByText("Location")).toBeInTheDocument();
    expect(await screen.findByText("49.01, 12.10")).toBeInTheDocument();
  });
});
