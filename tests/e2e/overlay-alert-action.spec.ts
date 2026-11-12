import { createHmac, randomUUID } from "node:crypto";
import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";

import {
  e2eOverlayToken,
  e2eWorkerEnvironment,
  e2eWorkerOrigin,
  seedE2EOverlayAlert,
} from "./worker-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "channel-e2e";

const pngCrc32 = (bytes: Buffer): number => {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ ((checksum & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
};

const pngChunk = (name: string, data: Buffer): Buffer => {
  const type = Buffer.from(name, "ascii");
  const contents = Buffer.concat([type, data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  checksum.writeUInt32BE(pngCrc32(contents));
  return Buffer.concat([length, contents, checksum]);
};

const createTwoByTwoPng = (): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([
    0, 255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const createSilentWav = (): Buffer => {
  const samples = Buffer.alloc(800, 128);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8_000, 24);
  header.writeUInt32LE(8_000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  return Buffer.concat([header, samples]);
};

test("a channel-points redemption shows its seeded alert in the connected overlay", async ({ page }) => {
  test.setTimeout(60_000);
  seedE2EOverlayAlert(createTwoByTwoPng(), createSilentWav());

  await page.addInitScript(() => {
    const trackedWindow = window as Window & { __cspViolations?: string[] };
    trackedWindow.__cspViolations = [];
    window.addEventListener("securitypolicyviolation", (event) => {
      trackedWindow.__cspViolations?.push(`${event.violatedDirective}: ${event.blockedURI}`);
    });
  });

  let connected = false;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname !== "/ws/overlay") return;
    socket.on("framereceived", ({ payload }) => {
      const frame = typeof payload === "string" ? payload : payload.toString("utf8");
      if (frame.includes('"system.hello"')) connected = true;
    });
  });
  await page.goto(`${e2eWorkerOrigin}/overlay.html#token=${encodeURIComponent(e2eOverlayToken)}`);
  await expect.poll(() => connected).toBe(true);

  const messageId = `eventsub-alert-${randomUUID()}`;
  const redemptionId = `redemption-alert-${randomUUID()}`;
  const timestamp = new Date().toISOString();
  const payload = {
    subscription: {
      id: "subscription-alert-e2e",
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: channelId },
      transport: { method: "webhook", callback: `${e2eWorkerOrigin}/api/twitch/eventsub` },
      created_at: timestamp,
    },
    event: {
      id: redemptionId,
      broadcaster_user_id: channelId,
      broadcaster_user_login: "kanal-e2e",
      broadcaster_user_name: "E2E Kanal",
      user_id: "viewer-alert-e2e",
      user_login: "viewer_demo",
      user_name: "Viewer Demo",
      user_input: "Bitte grüße den Chat",
      status: "unfulfilled",
      redeemed_at: timestamp,
      reward: { id: "twitch-reward-alert-e2e", title: "Einblendung testen", prompt: "Schreibe einen Gruß", cost: 100 },
    },
  };
  const body = Buffer.from(JSON.stringify(payload));
  const secretRing = JSON.parse(e2eWorkerEnvironment.TWITCH_EVENTSUB_SECRET ?? "{}") as {
    active?: { key?: string };
  };
  const eventSubKey = secretRing.active?.key;
  if (eventSubKey === undefined) throw new Error("The E2E EventSub signing key is missing.");
  const signature = createHmac("sha256", eventSubKey)
    .update(messageId)
    .update(timestamp)
    .update(body)
    .digest("hex");

  const response = await page.request.post(`${e2eWorkerOrigin}/api/twitch/eventsub`, {
    headers: {
      "Content-Type": "application/json",
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": "notification",
    },
    data: body,
  });
  expect(response.status()).toBe(204);

  await expect(page.getByText("Viewer Demo: Bitte grüße den Chat", { exact: true })).toBeVisible();
  const image = page.locator(".overlay-alert__image");
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
  const audio = page.locator(".overlay-alert audio");
  await expect.poll(() => audio.getAttribute("src")).toMatch(/^blob:/u);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState > 0 || element.error !== null))
    .toBe(true);
  expect(await page.evaluate(() => (window as Window & { __cspViolations?: string[] }).__cspViolations ?? [])).toEqual([]);
});
