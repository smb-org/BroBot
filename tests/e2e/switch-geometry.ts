import { expect, type Page } from "@playwright/test";
import { waitForWebFonts } from "./web-fonts";

/** Smallest gap, in px, that must remain between a switch thumb and every edge of its track. */
const MIN_INSET = 1.5;

/** Asserts that every visible switch is 36x20 with its thumb fully inside the track, in both states. */
export const expectSwitchGeometry = async (page: Page): Promise<void> => {
  await waitForWebFonts(page);
  const switches = await page.locator('[data-slot="switch"]:visible').all();
  expect(switches.length).toBeGreaterThan(0);
  for (const control of switches) {
    const boxes = await control.evaluate((element) => {
      const track = element.getBoundingClientRect();
      const thumb = element.querySelector('[data-slot="switch-thumb"]')?.getBoundingClientRect();
      return thumb === undefined ? null : {
        track: { x: track.x, y: track.y, width: track.width, height: track.height },
        thumb: { x: thumb.x, y: thumb.y, width: thumb.width, height: thumb.height },
      };
    });
    expect(boxes).not.toBeNull();
    if (boxes === null) return;
    const { track, thumb } = boxes;
    expect({ width: Math.round(track.width), height: Math.round(track.height) }).toEqual({ width: 36, height: 20 });
    expect(thumb.x - track.x).toBeGreaterThanOrEqual(MIN_INSET);
    expect(thumb.y - track.y).toBeGreaterThanOrEqual(MIN_INSET);
    expect(track.x + track.width - (thumb.x + thumb.width)).toBeGreaterThanOrEqual(MIN_INSET);
    expect(track.y + track.height - (thumb.y + thumb.height)).toBeGreaterThanOrEqual(MIN_INSET);
  }
};

/** Asserts that each message heading and its switch share one centre line, within 1 px. */
export const expectMessageHeadingsCentred = async (page: Page): Promise<void> => {
  await waitForWebFonts(page);
  const headings = await page.locator(".ui-settings-editor__message-heading, .duel-settings-editor__text-heading").all();
  expect(headings.length).toBeGreaterThan(0);
  for (const heading of headings) {
    const boxes = await heading.evaluate((element) => {
      const title = element.querySelector(":scope > strong, :scope > label")?.getBoundingClientRect();
      const control = element.querySelector('[data-slot="switch"]')?.getBoundingClientRect();
      return title === undefined || control === undefined ? null : {
        title: { y: title.y, height: title.height },
        control: { y: control.y, height: control.height },
      };
    });
    expect(boxes).not.toBeNull();
    if (boxes === null) return;
    const { title, control } = boxes;
    expect(Math.abs(title.y + title.height / 2 - (control.y + control.height / 2))).toBeLessThanOrEqual(1);
  }
};

/** Toggles one message switch and asserts that its heading keeps its height. */
export const expectHeadingHeightStable = async (page: Page, switchName: string): Promise<void> => {
  await waitForWebFonts(page);
  const control = page.getByRole("switch", { name: switchName });
  const heading = control.locator("xpath=ancestor::*[contains(@class, 'message-heading') or contains(@class, 'text-heading')][1]");
  const before = await heading.boundingBox();
  await control.click();
  const after = await heading.boundingBox();
  expect(after?.height).toBe(before?.height);
};
