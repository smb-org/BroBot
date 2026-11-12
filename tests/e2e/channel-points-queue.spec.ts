import { expect, test, type Page, type Route } from "@playwright/test";

import type { ChannelPointsQueueItem } from "../../src/modules/channel_points/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "fictional_channel_points_queue_channel";
const basePath = `/api/channels/${channelId}/modules/channel_points`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const earlyAt = "2030-01-01T10:00:00.000Z";
const lateAt = "2030-01-01T11:00:00.000Z";

const redemption = (id: string, redeemedAt: string, userName: string): ChannelPointsQueueItem => ({
  redemptionId: id,
  rewardId: "reward_queue",
  twitchRewardId: "twitch_reward_queue",
  rewardTitle: "Wunsch aus dem Chat",
  userId: `viewer_${id}`,
  userLogin: userName.toLowerCase().replaceAll(" ", "_"),
  userName,
  userInput: "Bitte spiele mein Lieblingslied",
  redeemedAt,
  status: "queued",
  pendingTwitchStatus: null,
  outcomeReason: null,
  createdAt: redeemedAt,
  updatedAt: redeemedAt,
  actionName: { de: "Chat-Nachricht", en: "Chat message" },
});

const installQueueApi = async (page: Page): Promise<void> => {
  let items = [
    redemption("redemption_late", lateAt, "Viewer Late"),
    redemption("redemption_early", earlyAt, "Viewer Early"),
  ];
  await page.route(`**${basePath}/queue`, async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill(json({ items }));
  });
  await page.route(`**${basePath}/redemptions/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const [redemptionId, operation] = url.pathname.slice(`${basePath}/redemptions/`.length).split("/");
    if (request.method() !== "POST" || redemptionId === undefined || (operation !== "run" && operation !== "refund")) {
      return route.fallback();
    }
    items = items.filter((entry) => entry.redemptionId !== redemptionId);
    return route.fulfill(json({ ok: true, status: operation === "run" ? "fulfilled" : "refunded" }));
  });
};

test("runs one queued reward and refunds another from the cockpit", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    role: "operator",
    modules: [{ id: "channel_points", enabled: true, settings: "{}" }],
  });
  await installQueueApi(page);

  await page.goto(`/channels/${channelId}?lang=de`);
  const action = page.getByRole("button", { name: "Kanalpunkte-Warteschlange" });
  await expect(action).toBeVisible();
  await action.click();

  const dialog = page.getByRole("dialog", { name: "Kanalpunkte-Warteschlange" });
  const oldest = dialog.getByRole("article", { name: "Viewer Early" });
  const newest = dialog.getByRole("article", { name: "Viewer Late" });
  await expect(oldest).toBeVisible();
  await expect(newest).toBeVisible();
  await expect(dialog.getByRole("article").nth(0)).toHaveAccessibleName("Viewer Early");
  await expect(oldest.getByText("Wunsch aus dem Chat")).toBeVisible();
  await expect(oldest.getByText("Bitte spiele mein Lieblingslied")).toHaveAttribute("title", "Bitte spiele mein Lieblingslied");

  await oldest.getByRole("button", { name: "Ausführen" }).click();
  await expect(oldest).toHaveCount(0);
  await newest.getByRole("button", { name: "Erstatten" }).click();
  await expect(newest).toHaveCount(0);
});
