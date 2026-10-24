import { expect, type Page } from "@playwright/test";

/** Smallest gap, in px, that must remain between a switch thumb and every edge of its track. */
const MIN_INSET = 1.5;

/** Asserts that every visible switch is 36x20 with its thumb fully inside the track, in both states. */
export const expectSwitchGeometry = async (page: Page): Promise<void> => {
  const switches = await page.locator('[data-slot="switch"]:visible').all();
  expect(switches.length).toBeGreaterThan(0);
  for (const control of switches) {
    const track = await control.boundingBox();
    const thumb = await control.locator('[data-slot="switch-thumb"]').boundingBox();
    expect(track).not.toBeNull();
    expect(thumb).not.toBeNull();
    if (track === null || thumb === null) return;
    expect({ width: Math.round(track.width), height: Math.round(track.height) }).toEqual({ width: 36, height: 20 });
    expect(thumb.x - track.x).toBeGreaterThanOrEqual(MIN_INSET);
    expect(thumb.y - track.y).toBeGreaterThanOrEqual(MIN_INSET);
    expect(track.x + track.width - (thumb.x + thumb.width)).toBeGreaterThanOrEqual(MIN_INSET);
    expect(track.y + track.height - (thumb.y + thumb.height)).toBeGreaterThanOrEqual(MIN_INSET);
  }
};
