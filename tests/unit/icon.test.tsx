import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Icon, type IconName } from "../../src/dashboard/ui/Icon";

const iconNames: Readonly<Record<IconName, true>> = {
  ad: true,
  shoutout: true,
  clip: true,
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
};

afterEach(cleanup);

describe("Icon", () => {
  it("renders every project icon as a hidden Tabler svg with the requested size and stroke", () => {
    for (const name of Object.keys(iconNames) as IconName[]) {
      const { container, unmount } = render(<Icon name={name} size={20} />);
      const svg = container.querySelector("svg");
      expect(svg, name).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
      expect(svg).toHaveAttribute("focusable", "false");
      expect(svg).toHaveAttribute("stroke-width", "1.5");
      expect(svg).toHaveAttribute("width", "20");
      expect(svg).toHaveAttribute("height", "20");
      unmount();
    }
  });
});
