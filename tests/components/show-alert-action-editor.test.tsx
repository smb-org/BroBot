import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ loadMediaAssets: vi.fn() }));
vi.mock("../../src/modules/overlay_alerts/panel/service", () => mocks);

import { UiProvider } from "../../src/dashboard/ui";
import ShowAlertActionEditor from "../../src/modules/overlay_alerts/panel/show-alert-editor";
import { renderWithQuery } from "../query-test-utils";

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("show alert action editor", () => {
  it("loads media, links to the library, and inserts text placeholders", async () => {
    mocks.loadMediaAssets.mockResolvedValue([
      { id: "asset-image", kind: "image", fileName: "stream.png", mimeType: "image/png", byteSize: 10, sha256: "a".repeat(64), createdAt: "2030-01-01T00:00:00.000Z" },
      { id: "asset-sound", kind: "sound", fileName: "bell.wav", mimeType: "audio/wav", byteSize: 10, sha256: "b".repeat(64), createdAt: "2030-01-01T00:00:00.000Z" },
    ]);
    const onChange = vi.fn();
    renderWithQuery(<UiProvider><ShowAlertActionEditor
      config={{ text: "Hi {user}", durationSeconds: 5, volumePercent: 80 }}
      onChange={onChange}
      channelId="channel_demo"
      language="de"
    /></UiProvider>);

    expect(await screen.findByRole("link", { name: "Medienbibliothek öffnen" })).toHaveAttribute(
      "href", "/channels/channel_demo/modules/overlay_alerts?lang=de",
    );
    expect(mocks.loadMediaAssets).toHaveBeenCalledWith("channel_demo", expect.any(AbortSignal));
    expect(screen.getByRole("spinbutton", { name: "Anzeigedauer" })).toHaveValue(5);
    expect(screen.getByRole("spinbutton", { name: "Lautstärke" })).toHaveValue(80);

    fireEvent.click(screen.getByRole("button", { name: "Platzhalter {input} einfügen" }));

    expect(onChange).toHaveBeenLastCalledWith({ text: "Hi {user}{input}", durationSeconds: 5, volumePercent: 80 });
  });
});
