import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  loadMediaAssets: vi.fn(),
  uploadMediaAsset: vi.fn(),
  deleteMediaAsset: vi.fn(),
  mediaAssetUrl: vi.fn((_channelId: string, asset: { id: string; sha256: string }) => `/media/${asset.id}/${asset.sha256}`),
}));

vi.mock("../../src/modules/overlay_alerts/panel/service", () => mocks);

import { PanelApiError } from "../../src/contracts/panel-error";
import OverlayAlertsPanel from "../../src/modules/overlay_alerts/panel";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

const imageAsset = {
  id: "image-asset",
  kind: "image" as const,
  mimeType: "image/png",
  byteSize: 128,
  sha256: "a".repeat(64),
  fileName: "sample.png",
  createdAt: "2026-11-10T12:00:00.000Z",
};

const soundAsset = {
  id: "sound-asset",
  kind: "sound" as const,
  mimeType: "audio/wav",
  byteSize: 120_400,
  sha256: "b".repeat(64),
  fileName: "chime.wav",
  createdAt: "2026-11-10T12:00:00.000Z",
};

const secondSound = { ...soundAsset, id: "sound-asset-2", sha256: "c".repeat(64), fileName: "fanfare.wav" };

const mount = (canManage: boolean) => renderWithQuery(
  <UiProvider><OverlayAlertsPanel channelId="media_channel_a" language="de" canManage={canManage} /></UiProvider>,
);

type FakeAudio = HTMLAudioElement & { fakePlaying?: boolean };

/** jsdom does not implement media playback, so model play, pause and paused. */
const installFakePlayback = () => {
  Object.defineProperty(HTMLMediaElement.prototype, "paused", {
    configurable: true,
    get(this: FakeAudio) { return this.fakePlaying !== true; },
  });
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (this: FakeAudio) {
    this.fakePlaying = true;
    return Promise.resolve();
  });
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (this: FakeAudio) {
    this.fakePlaying = false;
  });
  return { play, pause };
};

describe("overlay alert media panel", () => {
  beforeEach(() => {
    mocks.loadMediaAssets.mockResolvedValue([imageAsset, soundAsset]);
    mocks.uploadMediaAsset.mockResolvedValue(imageAsset);
    mocks.deleteMediaAsset.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  it("lists images with thumbnails and sounds with playback controls", async () => {
    mount(true);

    expect(await screen.findByRole("heading", { name: "Medien" })).toBeVisible();
    expect(await screen.findByText("sample.png")).toBeVisible();
    expect(screen.getByAltText("Vorschau: sample.png")).toBeVisible();
    expect(screen.getByText("chime.wav")).toBeVisible();
    expect(screen.getByText("Bild · 128 B")).toBeVisible();
    expect(screen.getByText("Sound · 118 KB")).toBeVisible();
    expect(screen.getByRole("button", { name: "Abspielen: chime.wav" })).toBeVisible();
  });

  it("keeps upload errors in the reserved status row", async () => {
    mocks.uploadMediaAsset.mockRejectedValue(new PanelApiError(413, "media_too_large", null));
    mount(true);
    await screen.findByText("sample.png");
    const file = new File([new Uint8Array([1, 2, 3])], "large.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Datei auswählen"), { target: { files: [file] } });

    await waitFor(() => expect(mocks.uploadMediaAsset).toHaveBeenCalledWith("media_channel_a", file));
    expect(await screen.findByRole("alert")).toHaveTextContent("Datei darf höchstens 1 MB groß sein.");
  });

  it("stops the first sound when a second preview starts and ignores its stale ended event", async () => {
    mocks.loadMediaAssets.mockResolvedValue([soundAsset, secondSound]);
    const { pause } = installFakePlayback();
    const { container } = mount(true);
    await screen.findByText("chime.wav");
    const [firstAudio, secondAudio] = Array.from(container.querySelectorAll("audio")) as FakeAudio[];

    fireEvent.click(screen.getByRole("button", { name: "Abspielen: chime.wav" }));
    await screen.findByRole("button", { name: "Pausieren: chime.wav" });
    fireEvent.click(screen.getByRole("button", { name: "Abspielen: fanfare.wav" }));

    await screen.findByRole("button", { name: "Pausieren: fanfare.wav" });
    expect(pause).toHaveBeenCalled();
    expect(firstAudio?.fakePlaying).toBe(false);
    expect(secondAudio?.fakePlaying).toBe(true);
    expect(screen.getByRole("button", { name: "Abspielen: chime.wav" })).toBeVisible();

    fireEvent.ended(firstAudio as HTMLAudioElement);
    expect(screen.getByRole("button", { name: "Pausieren: fanfare.wav" })).toBeVisible();

    fireEvent.ended(secondAudio as HTMLAudioElement);
    expect(await screen.findByRole("button", { name: "Abspielen: fanfare.wav" })).toBeVisible();
  });

  it("keeps an uploaded asset listed when the initial list response arrives late", async () => {
    let resolveInitial: (assets: unknown[]) => void = () => undefined;
    mocks.loadMediaAssets
      .mockReturnValueOnce(new Promise((resolve) => { resolveInitial = resolve; }))
      .mockResolvedValue([imageAsset]);
    mount(true);
    const file = new File([new Uint8Array([1, 2, 3])], "sample.png", { type: "image/png" });

    fireEvent.change(await screen.findByLabelText("Datei auswählen"), { target: { files: [file] } });
    expect(await screen.findByText("sample.png")).toBeVisible();

    resolveInitial([]);
    await waitFor(() => expect(mocks.loadMediaAssets).toHaveBeenCalledTimes(2));
    expect(screen.getByText("sample.png")).toBeVisible();
    expect(screen.queryByText("Noch keine Medien")).not.toBeInTheDocument();
  });

  it("hides upload and delete actions from read-only members", async () => {
    mount(false);

    await screen.findByText("sample.png");

    expect(screen.queryByRole("button", { name: "Datei hochladen" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Löschen: sample.png" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Löschen: chime.wav" })).not.toBeInTheDocument();
  });

  it("shows the referencing reward names when deletion is blocked", async () => {
    mocks.deleteMediaAsset.mockRejectedValue(new PanelApiError(409, "media_in_use", {
      error: "media_in_use",
      rewards: ["Einblendung im Stream", "Community-Wunsch"],
    }));
    mount(true);
    await screen.findByText("sample.png");
    fireEvent.click(screen.getByRole("button", { name: "Löschen: sample.png" }));
    fireEvent.click(screen.getByRole("button", { name: "Löschen" }));

    expect(await screen.findByText(
      "„sample.png“ wird in diesen Prämien verwendet: Einblendung im Stream, Community-Wunsch. Entferne die Datei zuerst aus den Prämien.",
    )).toBeVisible();
    expect(within(screen.getByRole("dialog")).getByText("Schließen")).toBeVisible();
  });
});
