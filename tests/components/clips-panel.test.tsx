import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import { useDashboardRoute } from "../../src/dashboard/router";
import ClipsPanel from "../../src/modules/clips/panel";
import type { ClipsSettings } from "../../src/modules/clips/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const settings: ClipsSettings = {
  commandMinimumRole: "viewer",
  commandCooldownSeconds: 60,
  postClipLinkInChat: true,
  chatLinkTemplate: "Clip aus dem Stream: {clip.title} {clip.url}",
  automaticClipsEnabled: false,
  automaticThresholdMultiplier: 2.5,
  automaticCooldownSeconds: 900,
};

const channelId = "kanal-a";
const settingsUrl = `/api/channels/${channelId}/modules/clips/settings`;
const clipsUrl = `/api/channels/${channelId}/clips`;

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

const deferred = <Value,>(): Deferred<Value> => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const requestPath = (input: RequestInfo | URL): string => new URL(
  input instanceof Request ? input.url : String(input),
  window.location.origin,
).pathname;

const requestMethod = (input: RequestInfo | URL, init?: RequestInit): string =>
  input instanceof Request ? input.method : init?.method ?? "GET";

const commandCooldown = (): HTMLInputElement => document.getElementById("clips-command-cooldown") as HTMLInputElement;

const baseFetch = vi.fn<typeof fetch>((input, init) => {
  const path = requestPath(input);
  if (path === settingsUrl && requestMethod(input, init) === "PATCH") return Promise.resolve(jsonResponse({ settings, revision: 2, warnings: [] }));
  if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings, revision: 1 }));
  if (path === clipsUrl) return Promise.resolve(jsonResponse({ streamStartedAt: null, clips: [] }));
  if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
  return Promise.resolve(jsonResponse({}));
});

const renderPanel = (fetcher: typeof fetch = baseFetch, canManage = true) => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(
    <UiProvider><ClipsPanel channelId={channelId} language="de" canManage={canManage} /></UiProvider>,
  );
};

describe("clips panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps navigation blocked until an already-pending save finishes", async () => {
    const pendingPatch = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === settingsUrl && requestMethod(input, init) === "PATCH") return pendingPatch.promise;
      if (path === settingsUrl) return jsonResponse({ settings, revision: 1 });
      if (path === clipsUrl) return jsonResponse({ streamStartedAt: null, clips: [] });
      if (path === "/api/csrf") return jsonResponse({ token: "csrf-test" });
      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", `/channels/${channelId}/modules/clips`);
    const Harness = (): ReactElement => {
      const [route, navigate] = useDashboardRoute();
      return <>
        <button type="button" onClick={() => { navigate({ kind: "overview" }); }}>Leave clips</button>
        <output>{route.kind}</output>
        {route.kind === "module" ? <ClipsPanel channelId={channelId} language="de" canManage /> : null}
      </>;
    };
    const { queryClient } = renderWithQuery(<UiProvider><Harness /></UiProvider>);
    await waitFor(() => expect(commandCooldown()).toBeInTheDocument());
    const cooldown = commandCooldown();
    fireEvent.change(cooldown, { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(cooldown).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Leave clips" }));
    const guard = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    fireEvent.click(within(guard).getByRole("button", { name: "Speichern und verlassen" }));

    expect(screen.getByText("module")).toBeInTheDocument();
    pendingPatch.resolve(jsonResponse({ error: "save_failed" }, 503));

    await waitFor(() => expect(within(guard).getByText("Die Clip-Einstellungen konnten nicht gespeichert werden.")).toBeInTheDocument());
    expect(screen.getByText("module")).toBeInTheDocument();
    expect(cooldown).toHaveValue(120);
    expect(queryClient.getQueryData(moduleQueryKey(channelId, "clips", "clips-settings"))).toBeDefined();
  });

  it("keeps edits made during a settings reload and rebases them on the loaded revision", async () => {
    const pendingReload = deferred<Response>();
    let settingsReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === settingsUrl && requestMethod(input, init) === "PATCH") {
        return jsonResponse({ settings, revision: 3, warnings: [] });
      }
      if (path === settingsUrl) {
        settingsReads += 1;
        return settingsReads === 1 ? jsonResponse({ settings, revision: 1 }) : pendingReload.promise;
      }
      if (path === clipsUrl) return jsonResponse({ streamStartedAt: null, clips: [] });
      if (path === "/api/csrf") return jsonResponse({ token: "csrf-test" });
      return jsonResponse({});
    });
    const { queryClient } = renderPanel(fetcher);
    await waitFor(() => expect(commandCooldown()).toBeInTheDocument());
    const cooldown = commandCooldown();
    fireEvent.change(cooldown, { target: { value: "120" } });
    queryClient.setQueryData(moduleQueryKey(channelId, "clips", "clips-settings"), { settings, revision: 2 });

    const reload = await screen.findByRole("button", { name: "Einstellungen neu laden" });
    fireEvent.click(reload);
    await waitFor(() => expect(settingsReads).toBe(2));
    fireEvent.change(cooldown, { target: { value: "180" } });
    pendingReload.resolve(jsonResponse({
      settings: { ...settings, commandCooldownSeconds: 300 },
      revision: 2,
    }));

    await waitFor(() => expect(cooldown).toHaveValue(180));
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Einstellungen neu laden" })).not.toBeInTheDocument();
  });

  it("shows a settings reload failure without clearing the current draft", async () => {
    const pendingReload = deferred<Response>();
    let settingsReads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const path = requestPath(input);
      if (path === settingsUrl && requestMethod(input, init) === "PATCH") return jsonResponse({ settings, revision: 3, warnings: [] });
      if (path === settingsUrl) {
        settingsReads += 1;
        return settingsReads === 1 ? jsonResponse({ settings, revision: 1 }) : pendingReload.promise;
      }
      if (path === clipsUrl) return jsonResponse({ streamStartedAt: null, clips: [] });
      if (path === "/api/csrf") return jsonResponse({ token: "csrf-test" });
      return jsonResponse({});
    });
    const { queryClient } = renderPanel(fetcher);
    await waitFor(() => expect(commandCooldown()).toBeInTheDocument());
    const cooldown = commandCooldown();
    fireEvent.change(cooldown, { target: { value: "120" } });
    queryClient.setQueryData(moduleQueryKey(channelId, "clips", "clips-settings"), { settings, revision: 2 });
    fireEvent.click(await screen.findByRole("button", { name: "Einstellungen neu laden" }));
    await waitFor(() => expect(settingsReads).toBe(2));
    pendingReload.resolve(jsonResponse({ error: "settings_unavailable" }, 503));

    expect(await screen.findByRole("alert", { name: "Die Clip-Einstellungen konnten nicht geladen werden." })).toBeInTheDocument();
    expect(cooldown).toHaveValue(120);
  });

  it("shows refresh failures while keeping the cached clip list visible", async () => {
    let failRefresh = false;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = requestPath(input);
      if (path === settingsUrl && requestMethod(input, init) === "PATCH") return Promise.resolve(jsonResponse({ settings, revision: 2, warnings: [] }));
      if (path === settingsUrl) return Promise.resolve(jsonResponse({ settings, revision: 1 }));
      if (path === clipsUrl) {
        return failRefresh
          ? Promise.resolve(jsonResponse({ error: "clips_unavailable" }, 503))
          : Promise.resolve(jsonResponse({ streamStartedAt: "2026-10-16T08:00:00.000Z", clips: [{ clipId: "clip-a", createdAt: "2026-10-16T08:01:00.000Z" }] }));
      }
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      return Promise.resolve(jsonResponse({}));
    });
    renderPanel(fetcher);
    expect(await screen.findByText("Clip clip-a")).toBeInTheDocument();

    failRefresh = true;
    fireEvent.click(screen.getByRole("button", { name: "Clips aktualisieren" }));

    expect(await screen.findByRole("alert", { name: "Die Clips dieser Sitzung konnten nicht geladen werden." })).toBeInTheDocument();
    expect(screen.getByText("Clip clip-a")).toBeInTheDocument();
  });

  it("shows one read-only reason and properties to operators", async () => {
    renderPanel(baseFetch, false);

    expect(await screen.findByRole("heading", { name: "Clip-Einstellungen", level: 2 })).toBeInTheDocument();
    expect(screen.getAllByText("Nur Broadcaster und Verwalter dürfen Clip-Einstellungen ändern.", { exact: true })).toHaveLength(1);
    expect(document.querySelector('dl[aria-label="Clip-Einstellungen"]')).not.toBeNull();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
  });

  it("requires at least one minute of automatic cooldown when automatic clips are enabled", async () => {
    renderPanel();
    await waitFor(() => expect(commandCooldown()).toBeInTheDocument());

    fireEvent.click(screen.getByRole("switch", { name: "Automatische Clips" }));

    expect(document.getElementById("clips-auto-cooldown")).toHaveAttribute("min", "60");
  });
});
