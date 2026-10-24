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

/** Asserts that each message heading and its switch share one centre line, within 1 px. */
export const expectMessageHeadingsCentred = async (page: Page): Promise<void> => {
  const headings = await page.locator(".ui-settings-editor__message-heading, .duel-settings-editor__text-heading").all();
  expect(headings.length).toBeGreaterThan(0);
  for (const heading of headings) {
    const title = await heading.locator(":scope > strong, :scope > label").first().boundingBox();
    const control = await heading.locator('[data-slot="switch"]').boundingBox();
    expect(title).not.toBeNull();
    expect(control).not.toBeNull();
    if (title === null || control === null) return;
    expect(Math.abs(title.y + title.height / 2 - (control.y + control.height / 2))).toBeLessThanOrEqual(1);
  }
};

/** Toggles one message switch and asserts that its heading keeps its height. */
export const expectHeadingHeightStable = async (page: Page, switchName: string): Promise<void> => {
  const control = page.getByRole("switch", { name: switchName });
  const heading = control.locator("xpath=ancestor::*[contains(@class, 'message-heading') or contains(@class, 'text-heading')][1]");
  const before = await heading.boundingBox();
  await control.click();
  const after = await heading.boundingBox();
  expect(after?.height).toBe(before?.height);
};
