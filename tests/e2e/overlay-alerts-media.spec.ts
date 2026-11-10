import { expect, test, type Page, type Route } from "@playwright/test";
import { Buffer } from "node:buffer";

import { installLiveCockpitMocks } from "./live-cockpit-regression-fixtures";

test.use({ locale: "de-DE", timezoneId: "Europe/Berlin" });

const channelId = "fictional_media_channel";
const basePath = "/api/channels/" + channelId + "/modules/overlay_alerts";
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const pngFixture = (): Buffer => Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/5WQAAAAASUVORK5CYII=",
  "base64",
);

const wavFixture = (): Buffer => {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const writeText = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, bytes.byteLength - 44, true);
  view.setInt16(44, 0, true);
  return Buffer.from(bytes);
};

interface MediaAsset {
  id: string;
  kind: "image" | "sound";
  mimeType: string;
  byteSize: number;
  sha256: string;
  fileName: string;
  createdAt: string;
}

const installMediaApi = async (page: Page): Promise<() => readonly MediaAsset[]> => {
  const assets: MediaAsset[] = [];
  await page.route("**" + basePath + "/media**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const relativePath = url.pathname.slice(basePath.length);
    if (relativePath === "/media" && request.method() === "GET") {
      return route.fulfill(json({ assets: [...assets] }));
    }
    if (relativePath === "/media" && request.method() === "POST") {
      const body = request.postDataBuffer()?.toString("latin1") ?? "";
      const fileName = /filename="([^"]+)"/u.exec(body)?.[1] ?? "upload.bin";
      const sound = fileName.endsWith(".wav");
      const asset: MediaAsset = {
        id: "asset-" + String(assets.length + 1),
        kind: sound ? "sound" : "image",
        mimeType: sound ? "audio/wav" : "image/png",
        byteSize: sound ? 46 : 68,
        sha256: String(assets.length + 1).repeat(64),
        fileName,
        createdAt: "2030-01-01T12:00:00.000Z",
      };
      assets.push(asset);
      return route.fulfill(json({ asset }, 201));
    }
    const deleteMatch = /^\/media\/([^/]+)$/u.exec(relativePath);
    if (deleteMatch !== null && request.method() === "DELETE") {
      const index = assets.findIndex((asset) => asset.id === deleteMatch[1]);
      if (index >= 0) assets.splice(index, 1);
      return route.fulfill({ status: 204, body: "" });
    }
    return route.fallback();
  });
  return () => assets;
};

test("uploads an image and a sound, lists both, and deletes one", async ({ page }) => {
  await installLiveCockpitMocks(page, {
    channelId,
    modules: [{ id: "overlay_alerts", enabled: true, settings: "{}" }],
  });
  const assets = await installMediaApi(page);

  await page.goto("/channels/" + channelId + "/modules/overlay_alerts?lang=de");
  await expect(page.getByRole("heading", { name: "Medien", exact: true })).toBeVisible();

  const png = pngFixture();
  const wav = wavFixture();
  const input = page.getByLabel("Datei auswählen");

  await input.setInputFiles({ name: "demo.png", mimeType: "image/png", buffer: png });
  await expect(page.getByText("demo.png", { exact: true })).toBeVisible();
  await input.setInputFiles({ name: "chime.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page.getByText("chime.wav", { exact: true })).toBeVisible();
  await expect.poll(() => assets().length).toBe(2);

  await page.getByRole("button", { name: "Löschen: demo.png" }).click();
  const dialog = page.getByRole("dialog", { name: "Datei löschen?" });
  await dialog.getByRole("button", { name: "Löschen", exact: true }).click();

  await expect(page.getByText("demo.png", { exact: true })).toHaveCount(0);
  await expect(page.getByText("chime.wav", { exact: true })).toBeVisible();
  await expect.poll(() => assets().length).toBe(1);
});
