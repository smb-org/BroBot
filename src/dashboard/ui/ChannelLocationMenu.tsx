import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useEffect, useState, type ReactElement } from "react";

import type { PanelChannelLocation } from "../../panel-contract";
import type { DashboardTexts } from "../locale";
import { Button } from "./Button";

type ChannelLocationMenuMessages = DashboardTexts["header"]["locationMenu"];

interface ExternalLocationTarget {
  label: string;
  href: (location: PanelChannelLocation) => string;
}

const numberForUrl = (value: number): string => String(value);
const coordinatesForDisplay = (location: PanelChannelLocation): string =>
  `${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)}`;
// The stored name is a full geocoded address ("Springfield, Illinois,
// United States"); the header shows only the first segment, keeps the full
// name as the title and menu heading, and (see below) folds it into the
// accessible name too when it was shortened.
const coordinateLikeName = /^\s*[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?\s*$/;
const displayLocationName = (name: string, fallback: string): string => {
  const trimmed = name.trim();
  return trimmed === "" || coordinateLikeName.test(trimmed) ? fallback : trimmed;
};
const shortLocationName = (name: string, fallback: string): string => displayLocationName(name, fallback).split(",")[0]?.trim() || fallback;

export function ChannelLocationMenu({ location, messages }: {
  location: PanelChannelLocation;
  messages: ChannelLocationMenuMessages;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const fullName = displayLocationName(location.name, messages.locationFallback);
  const shortName = shortLocationName(location.name, messages.locationFallback);
  const namedLocation = { ...location, name: fullName };

  useEffect(() => {
    if (copyStatus === null) return undefined;
    const timeout = window.setTimeout(() => setCopyStatus(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const externalTargets: readonly ExternalLocationTarget[] = [
    {
      label: messages.openStreetMap,
      href: ({ latitude, longitude }) => `https://www.openstreetmap.org/?mlat=${numberForUrl(latitude)}&mlon=${numberForUrl(longitude)}#map=12/${numberForUrl(latitude)}/${numberForUrl(longitude)}`,
    },
    {
      label: messages.googleMaps,
      href: ({ latitude, longitude }) => `https://www.google.com/maps/search/?api=1&query=${numberForUrl(latitude)},${numberForUrl(longitude)}`,
    },
    {
      label: messages.appleMaps,
      href: ({ latitude, longitude, name }) => `https://maps.apple.com/?ll=${numberForUrl(latitude)},${numberForUrl(longitude)}&q=${encodeURIComponent(name)}`,
    },
  ];

  const copyCoordinates = async (): Promise<void> => {
    const clipboard = Reflect.get(navigator, "clipboard") as { writeText: (text: string) => Promise<void> } | undefined;
    if (clipboard === undefined) {
      setCopyStatus("failed");
      return;
    }
    try {
      await clipboard.writeText(`${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  return (
    <div data-ui="" className="dashboard-header__location-wrap">
      <MenuPrimitive.Root open={opened} onOpenChange={setOpened}>
        <MenuPrimitive.Trigger render={<Button
            className="dashboard-header__location"
            variant="subtle"
            ariaHasPopup="menu"
            ariaExpanded={opened}
            title={fullName}
            onClick={() => setCopyStatus(null)}
          >
            <span className="dashboard-header__location-label">
              <span className="dashboard-header__location-name">{shortName}</span>
            </span>
            {/* No aria-label override: the accessible name is derived from
                this content, so it starts with the visible label (WCAG
                2.5.3). The full name is appended only when it was actually
                shortened -- visually hidden, never duplicating a name that's
                already fully visible. */}
            {shortName === fullName ? null : <span className="sr-only">, {fullName}</span>}
          </Button>} />
        <MenuPrimitive.Portal>
          <MenuPrimitive.Positioner side="bottom" align="start" sideOffset={4} className="z-[var(--layer-popover)]" style={{ zIndex: "var(--layer-popover)" }}>
            <MenuPrimitive.Popup data-ui="" className="dashboard-header__location-menu">
              <div className="dashboard-header__location-menu-label dashboard-header__location-menu-label--title">{fullName}</div>
              <div className="dashboard-header__location-menu-label dashboard-header__location-menu-label--coordinates mono">{coordinatesForDisplay(location)}</div>
              <MenuPrimitive.Separator className="dashboard-header__location-menu-divider" />
              <div className="dashboard-header__location-menu-label dashboard-header__location-menu-label--section">{messages.openIn}</div>
              {externalTargets.map((target) => <MenuPrimitive.Item
                key={target.label}
                render={<a href={target.href(namedLocation)} target="_blank" rel="noopener noreferrer" />}
                className="dashboard-header__location-menu-item"
              >{target.label}</MenuPrimitive.Item>)}
              <MenuPrimitive.Separator className="dashboard-header__location-menu-divider" />
              <MenuPrimitive.Item className="dashboard-header__location-menu-item" onClick={() => { void copyCoordinates(); }}>
                {copyStatus === "copied" ? messages.coordinatesCopied : copyStatus === "failed" ? messages.copyCoordinatesFailed : messages.copyCoordinates}
              </MenuPrimitive.Item>
            </MenuPrimitive.Popup>
          </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>
      {copyStatus === null ? null : <span className="dashboard-header__location-copy-status" role="status" aria-live="polite">
        {copyStatus === "copied" ? messages.coordinatesCopied : messages.copyCoordinatesFailed}
      </span>}
    </div>
  );
}
