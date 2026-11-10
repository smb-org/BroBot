import { expect, test, type Page, type Route } from "@playwright/test";

import type { ChannelPointsRedemption, ChannelPointsReward, ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";
import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "fictional_channel_points_channel";
const basePath = `/api/channels/${channelId}/modules/channel_points`;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const at = "2030-01-01T12:00:00.000Z";

const installChannelPointsApi = async (page: Page): Promise<{
  getRewards: () => readonly ChannelPointsReward[];
  lastUpdate: () => ChannelPointsRewardInput | null;
}> => {
  let rewards: ChannelPointsReward[] = [];
  let lastUpdate: ChannelPointsRewardInput | null = null;
  const history: ChannelPointsRedemption[] = [{
    redemptionId: "redemption-seeded",
    rewardId: "reward-seeded",
    twitchRewardId: "twitch-reward-seeded",
    rewardTitle: "Wunsch aus dem Chat",
    userId: "viewer-seeded",
    userLogin: "viewer_echo",
    userName: "Viewer Echo",
    userInput: "Bitte grüße den Chat",
    redeemedAt: at,
    status: "fulfilled",
    pendingTwitchStatus: null,
    outcomeReason: null,
    createdAt: at,
    updatedAt: at,
  }];

  await page.route(`**${basePath}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice(basePath.length);
    if (path === "/state" && request.method() === "GET") {
      return route.fulfill(json({
        rewards,
        moduleEnabled: true,
        connection: { connected: true, scopes: ["channel:read:redemptions", "channel:manage:redemptions"], missingScopes: [] },
      }));
    }
    if (path === "/redemptions" && request.method() === "GET") return route.fulfill(json({ items: history, cursor: null }));
    if (path === "/reconcile" && request.method() === "POST") return route.fulfill(json({ ok: true }));
    if (path === "/rewards" && request.method() === "POST") {
      const input = request.postDataJSON() as ChannelPointsRewardInput;
      const created: ChannelPointsReward = {
        ...input,
        id: "reward-created",
        twitchRewardId: "twitch-reward-created",
        twitchState: "active",
        createdAt: at,
        updatedAt: at,
      };
      rewards = [created];
      return route.fulfill(json({ reward: created }, 201));
    }
    if (path === "/rewards/reward-created" && request.method() === "PUT") {
      lastUpdate = request.postDataJSON() as ChannelPointsRewardInput;
      const currentReward = rewards[0];
      if (currentReward === undefined) return route.fulfill(json({ error: "channel_points_reward_not_found" }, 404));
      const updated: ChannelPointsReward = {
        ...currentReward,
        ...lastUpdate,
        id: "reward-created",
        twitchRewardId: "twitch-reward-created",
        twitchState: "active",
        createdAt: at,
        updatedAt: at,
      };
      rewards = [updated];
      return route.fulfill(json({ reward: updated }));
    }
    return route.fallback();
  });

  return { getRewards: () => rewards, lastUpdate: () => lastUpdate };
};

test("creates and edits a channel-points reward and shows a seeded redemption", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "channel_points", enabled: true, settings: "{}" }],
  });
  const api = await installChannelPointsApi(page);

  await page.goto(`/channels/${channelId}/modules/channel_points?lang=de`);
  await expect(page.getByRole("region", { name: "Verlauf" })).toBeVisible();
  await expect(page.getByText("Viewer Echo", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Neu", exact: true }).click();
  const createDialog = page.getByRole("dialog", { name: "Neue Belohnung" });
  await createDialog.getByLabel("Titel").fill("Wunsch aus dem Chat");
  await createDialog.getByLabel("Kosten").fill("250");
  await createDialog.getByLabel("Chat-Nachricht").fill("Danke, {user}!");
  await createDialog.getByRole("button", { name: "Speichern", exact: true }).click();

  await expect.poll(() => api.getRewards().length).toBe(1);
  const row = page.getByRole("article", { name: "Wunsch aus dem Chat", exact: true });
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: /Weitere Aktionen/u }).click();
  await page.getByRole("menuitem", { name: "Bearbeiten" }).click();
  const editDialog = page.getByRole("dialog", { name: "Belohnung bearbeiten" });
  await editDialog.getByLabel("Kosten").fill("400");
  await editDialog.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect.poll(() => api.lastUpdate()?.cost ?? null).toBe(400);
  await expect(row.getByText("400")).toBeVisible();
  await expect(page.getByText("Erledigt", { exact: true })).toBeVisible();
});
