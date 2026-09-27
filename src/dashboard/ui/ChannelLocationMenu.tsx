import { Menu } from "@mantine/core";
import { useEffect, useState, type ReactElement } from "react";

import type { PanelChannelLocation } from "../../panel-contract";
import { Button } from "./Button";

export interface ChannelLocationMenuMessages {
  openIn: string;
  openStreetMap: string;
  googleMaps: string;
  appleMaps: string;
  copyCoordinates: string;
  coordinatesCopied: string;
  copyCoordinatesFailed: string;
}

interface ExternalLocationTarget {
  label: string;
  href: (location: PanelChannelLocation) => string;
}

const numberForUrl = (value: number): string => String(value);
const coordinatesForDisplay = (location: PanelChannelLocation): string =>
  `${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)}`;
// The stored name is a full geocoded address ("Springfield, Illinois,
// United States"); the header shows only the first segment and keeps the full
// name as the accessible name, title, and menu heading.
const shortLocationName = (name: string): string => name.split(",")[0]?.trim() || name;

export function ChannelLocationMenu({ location, messages }: {
  location: PanelChannelLocation;
  messages: ChannelLocationMenuMessages;
}): ReactElement {
  const [opened, setOpened] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);

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
    <div className="dashboard-header__location-wrap">
      <Menu opened={opened} onChange={setOpened} position="bottom-start" withinPortal closeOnItemClick={false}>
        <Menu.Target>
          <Button
            className="dashboard-header__location"
            variant="subtle"
            ariaHasPopup="menu"
            ariaExpanded={opened}
            ariaLabel={location.name}
            title={location.name}
            onClick={() => setCopyStatus(null)}
          >
            <span className="dashboard-header__location-label">
              <span className="dashboard-header__location-name">{shortLocationName(location.name)}</span>
              <span className="dashboard-header__location-coordinates mono"> · {coordinatesForDisplay(location)}</span>
            </span>
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>{location.name}</Menu.Label>
          <Menu.Label className="mono">{coordinatesForDisplay(location)}</Menu.Label>
          <Menu.Divider />
          <Menu.Label>{messages.openIn}</Menu.Label>
          {externalTargets.map((target) => <Menu.Item
            key={target.label}
            component="a"
            href={target.href(location)}
            target="_blank"
            rel="noopener noreferrer"
          >{target.label}</Menu.Item>)}
          <Menu.Divider />
          <Menu.Item onClick={() => { void copyCoordinates(); }}>
            {copyStatus === "copied" ? messages.coordinatesCopied : copyStatus === "failed" ? messages.copyCoordinatesFailed : messages.copyCoordinates}
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {copyStatus === null ? null : <span className="dashboard-header__location-copy-status" role="status" aria-live="polite">
        {copyStatus === "copied" ? messages.coordinatesCopied : messages.copyCoordinatesFailed}
      </span>}
    </div>
  );
}
