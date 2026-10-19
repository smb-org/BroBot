import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import ClipsPanel from "../../src/modules/clips/panel";
import type { ClipsSettings } from "../../src/modules/clips/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-a";
const settingsUrl = `/api/channels/${channelId}/modules/clips/settings`;
const clipsUrl = `/api/channels/${channelId}/clips`;

const settings: ClipsSettings = {
  commandMinimumRole: "vip",
  commandCooldownSeconds: 180,
  postClipLinkInChat: true,
  chatLinkTemplate: "Clip: {clip.title} {clip.url}",
  automaticClipsEnabled: true,
  automaticThresholdMultiplier: 3.5,
  automaticCooldownSeconds: 1200,
};

const pathOf = (input: RequestInfo | URL): string => new URL(
  input instanceof Request ? input.url : String(input),
  window.location.origin,
).pathname;

describe("clips command settings panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("saves an edited clip-link template explicitly while leaving automatic clips locked", async () => {
    let storedSettings = settings;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = pathOf(input);
      if (path === settingsUrl && init?.method === "PATCH") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { settings: ClipsSettings } : null;
        if (body !== null) storedSettings = body.settings;
        return Promise.resolve(jsonResponse({ settings: storedSettings, revision: 2 }));
      }
      if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings: storedSettings, revision: 1 }));
      if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><ClipsPanel channelId={channelId} language="en" /></UiProvider>);

    expect(await screen.findByRole("heading", { name: "Chat command !clip", level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Minimum role" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Cooldown" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Enabled" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Chat message" })).toBeEnabled();
    expect(screen.getByRole("switch", { name: "Automatic clips" })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Threshold relative to stream average" })).toBeDisabled();
    expect(screen.queryByText("Coming in a later version.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Chat message" }), {
      target: { value: "New clip: {clip.title} {clip.url}" },
    });
    const saveButton = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(fetcher.mock.calls.filter(([input, init]) => pathOf(input) === settingsUrl && init?.method === "PATCH")).toHaveLength(0);

    fireEvent.click(saveButton);

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) =>
      pathOf(input) === settingsUrl && init?.method === "PATCH" && typeof init.body === "string" &&
      init.body.includes("New clip: {clip.title} {clip.url}"),
    )).toBe(true));
  });

  it("keeps a saved revision when an older settings GET finishes after the PATCH", async () => {
    let storedSettings = settings;
    let revision = 1;
    let settingsGets = 0;
    let resolveOlderGet!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = pathOf(input);
      if (path === settingsUrl && init?.method === "PATCH") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { settings: ClipsSettings } : null;
        if (body !== null) storedSettings = body.settings;
        revision += 1;
        return Promise.resolve(jsonResponse({ settings: storedSettings, revision }));
      }
      if (path === settingsUrl) {
        settingsGets += 1;
        if (settingsGets === 2) return new Promise((resolve) => { resolveOlderGet = resolve; });
        return Promise.resolve(jsonResponse({ settings: storedSettings, revision }));
      }
      if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(<UiProvider><ClipsPanel channelId={channelId} language="en" /></UiProvider>);
    const message = await screen.findByRole("textbox", { name: "Chat message" });
    const olderGet = queryClient.invalidateQueries({ queryKey: moduleQueryKey(channelId, "clips", "clips-settings"), exact: true });
    await waitFor(() => expect(settingsGets).toBe(2));
    fireEvent.change(message, { target: { value: "Saved: {clip.title} {clip.url}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(queryClient.getQueryData(moduleQueryKey(channelId, "clips", "clips-settings")))
      .toEqual({ settings: { ...settings, chatLinkTemplate: "Saved: {clip.title} {clip.url}" }, revision: 2 }));
    resolveOlderGet(jsonResponse({ settings, revision: 1 }));
    await olderGet;

    await waitFor(() => expect(message).toHaveValue("Saved: {clip.title} {clip.url}"));
    expect(queryClient.getQueryData(moduleQueryKey(channelId, "clips", "clips-settings")))
      .toEqual({ settings: { ...settings, chatLinkTemplate: "Saved: {clip.title} {clip.url}" }, revision: 2 });
  });
});
