import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Icon, type IconName } from "../../src/dashboard/ui/Icon";

const iconNames: Readonly<Record<IconName, true>> = {
  ad: true,
  cloud: true,
  "cloud-fog": true,
  "cloud-lightning": true,
  "cloud-moon": true,
  "cloud-rain": true,
  "cloud-snow": true,
  "cloud-sun": true,
  moon: true,
  sun: true,
  wind: true,
  shoutout: true,
  clip: true,
  timer: true,
  boss: true,
  blitz: true,
  duel: true,
  quiz: true,
  counter: true,
  "test-message": true,
  marker: true,
  add: true,
  remove: true,
  close: true,
  copy: true,
  copied: true,
  reload: true,
  search: true,
  lock: true,
  external: true,
  warning: true,
  jumpToTop: true,
  trendUp: true,
  trendDown: true,
  sortAscending: true,
  sortDescending: true,
  sort: true,
  collapse: true,
  minus: true,
  plus: true,
  member: true,
  memberAdd: true,
  memberRemove: true,
  tierEveryone: true,
  tierSubscriber: true,
  tierVip: true,
  tierModerator: true,
  tierBroadcaster: true,
  tabSettings: true,
  tabAdvanced: true,
  tabCode: true,
  styleFont: true,
  styleOutline: true,
  styleShadow: true,
  styleBackground: true,
  tabMessages: true,
  tabPrewarning: true,
  broadcast: true,
  vote: true,
  "broadcast-off": true,
  "volume-3": true,
  "volume-off": true,
  "player-pause": true,
  "player-play": true,
  "clock-hour-4": true,
  "chevron-left": true,
  "chevron-right": true,
  info: true,
  eye: true,
  cause: true,
  edit: true,
  more: true,
  "map-pin": true,
  drag: true,
  token: true,
  variable: true,
};

afterEach(cleanup);

describe("Icon", () => {
  it("renders every project icon as a hidden lucide svg with the requested size and stroke", () => {
    for (const name of Object.keys(iconNames) as IconName[]) {
      const { container, unmount } = render(<Icon name={name} size={20} />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      expect(svg?.getAttribute("stroke-width")).toBe("1.5");
      expect(svg?.getAttribute("width")).toBe("20");
      expect(svg?.getAttribute("height")).toBe("20");
      unmount();
    }
  });
});
