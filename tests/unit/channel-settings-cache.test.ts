import { describe, expect, it } from "vitest";

import type { PanelChannelSettings } from "../../src/dashboard/api";
import { mergeChannelSettingsResponse } from "../../src/dashboard/channel-settings-cache";

const settings: PanelChannelSettings = {
  timeZone: "Europe/Berlin",
  revision: 2,
  location: { name: "Berlin", latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" },
  locationRevision: 2,
  defaultChatTarget: "source_only",
  defaultChatTargetRevision: 2,
};

describe("channel settings response cache merge", () => {
  it("does not apply a late time-zone response over a newer realtime revision", () => {
    const current = { ...settings, timeZone: "UTC", revision: 3 };

    expect(mergeChannelSettingsResponse(current, { timeZone: "Europe/Berlin", revision: 2 }))
      .toMatchObject({ timeZone: "UTC", revision: 3 });
  });

  it("does not apply a late location response over a newer realtime revision", () => {
    const current = {
      ...settings,
      location: { name: "Hamburg", latitude: 53.5511, longitude: 9.9937, timeZone: "Europe/Berlin" },
      locationRevision: 3,
    };

    expect(mergeChannelSettingsResponse(current, { location: settings.location, locationRevision: 2 }))
      .toMatchObject({ location: current.location, locationRevision: 3 });
  });
});
