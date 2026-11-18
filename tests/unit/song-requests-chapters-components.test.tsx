import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { moduleQueryKey } from "../../src/dashboard/data";
import { reconcileDashboardPanelResourceRevisions } from "../../src/dashboard/data/realtime";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";
import { songRequestsModule } from "../../src/modules/song_requests";
import SongRequestChapterCockpitAction from "../../src/modules/song_requests/panel/chapter-cockpit-action";
import SongRequestsPanel from "../../src/modules/song_requests/panel";
import type { SongRequestChapter } from "../../src/modules/song_requests/contracts";

const channelId = "channel-soundtrack-fictional";
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const urlOf = (input: RequestInfo | URL): URL => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
const chapter = (overrides: Partial<SongRequestChapter> = {}): SongRequestChapter => ({
  id: "chapter-night-drive",
  channelId,
  name: "Night Drive",
  tracks: [],
  offerInCockpit: true,
  revision: 1,
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("song request chapter and recap components", () => {
  it("adds up to twenty Spotify tracks and saves the chapter draft explicitly", async () => {
    const searchTracks = Array.from({ length: 21 }, (_value, index) => ({
      id: `fictionaltrack${String(index + 1).padStart(2, "0")}`,
      title: `Fictional Track ${String(index + 1)}`,
      artists: ["Mira Vale"],
      coverUrl: index === 0 ? "https://i.scdn.co/image/fictional-cover" : null,
      spotifyUrl: `https://open.spotify.com/track/fictionaltrack${String(index + 1).padStart(2, "0")}`,
    }));
    let chapters: SongRequestChapter[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-fictional" }));
      if (url.pathname.endsWith("/chapters") && init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { name: string; tracks: SongRequestChapter["tracks"]; offerInCockpit: boolean };
        const saved = chapter({ name: body.name, tracks: body.tracks, offerInCockpit: body.offerInCockpit });
        chapters = [saved];
        return Promise.resolve(json({ chapter: saved }, 201));
      }
      if (url.pathname.endsWith("/chapters")) return Promise.resolve(json({ chapters }));
      if (url.pathname.endsWith("/search")) return Promise.resolve(json({ tracks: searchTracks }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<DashboardDataProvider><SongRequestsPanel channelId={channelId} pageId="chapters" language="en" canManage canOperate /></DashboardDataProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Create chapter" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chapter name" }), { target: { value: "Night Drive" } });
    fireEvent.click(screen.getByRole("switch", { name: "Offer in cockpit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search Spotify" }), { target: { value: "Fictional Track" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Fictional Track 21");

    for (let index = 0; index < 20; index += 1) {
      fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0] as HTMLElement);
    }
    expect(screen.getByText("20 tracks / 20")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    expect(chapters).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => { expect(chapters[0]?.tracks).toHaveLength(20); });
    expect(chapters[0]).toMatchObject({ name: "Night Drive", offerInCockpit: true });
    expect(fetcher.mock.calls.some(([input, init]) => urlOf(input).pathname.endsWith("/chapters") && init?.method === "POST")).toBe(true);
  });

  it("keeps the draft baseline revision and shows the server conflict after a background refresh", async () => {
    let serverChapter = chapter();
    let listFetches = 0;
    let patchBody: { revision: number; name: string; tracks: SongRequestChapter["tracks"]; offerInCockpit: boolean } | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-fictional" }));
      if (url.pathname.includes("/chapters/") && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string) as { revision: number; name: string; tracks: SongRequestChapter["tracks"]; offerInCockpit: boolean };
        if (patchBody.revision !== serverChapter.revision) return Promise.resolve(json({ error: "song_request_chapter_conflict" }, 409));
        serverChapter = chapter({ ...serverChapter, name: patchBody.name, revision: serverChapter.revision + 1 });
        return Promise.resolve(json({ chapter: serverChapter }));
      }
      if (url.pathname.endsWith("/chapters")) {
        listFetches += 1;
        return Promise.resolve(json({ chapters: [serverChapter] }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(<SongRequestsPanel channelId={channelId} pageId="chapters" language="en" canManage canOperate />);
    fireEvent.click(await screen.findByRole("link", { name: /Night Drive/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chapter name" }), { target: { value: "Local edit" } });

    serverChapter = chapter({ revision: 2 });
    const fetchesBefore = listFetches;
    await queryClient.invalidateQueries({ queryKey: moduleQueryKey(channelId, "song_requests", "chapters"), exact: true });
    await waitFor(() => { expect(listFetches).toBeGreaterThan(fetchesBefore); });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findAllByText("This chapter changed. Reload the list and try again.")).length).toBeGreaterThan(0);
    expect(patchBody).toMatchObject({
      revision: 1,
      name: "Local edit",
    });
    expect(screen.getByRole("textbox", { name: "Chapter name" })).toHaveValue("Local edit");
  });

  it("blocks dashboard navigation while chapter changes are unsaved", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/chapters")) return Promise.resolve(json({ chapters: [chapter()] }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<SongRequestsPanel channelId={channelId} pageId="chapters" language="en" canManage canOperate />);
    fireEvent.click(await screen.findByRole("link", { name: /Night Drive/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chapter name" }), { target: { value: "Unsaved edit" } });
    const proceed = vi.fn();
    const cancel = vi.fn();

    runDashboardNavigationGuards(proceed, cancel);

    expect(await screen.findByText("This chapter has unsaved changes.")).toBeInTheDocument();
    expect(proceed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard and switch" }));
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("keeps the requested chapter selected when save-and-switch refresh finishes later", async () => {
    let serverChapters = [
      chapter(),
      chapter({ id: "chapter-daybreak", name: "Daybreak", revision: 1 }),
    ];
    let patchCompleted = false;
    let refreshStarted = false;
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-fictional" }));
      if (url.pathname.includes("/chapters/") && init?.method === "PATCH") {
        const body = JSON.parse(init.body as string) as { revision: number; name: string };
        const saved = chapter({ name: body.name, revision: body.revision + 1 });
        serverChapters = [saved, serverChapters[1] as SongRequestChapter];
        patchCompleted = true;
        return Promise.resolve(json({ chapter: saved }));
      }
      if (url.pathname.endsWith("/chapters")) {
        if (!patchCompleted) return Promise.resolve(json({ chapters: serverChapters }));
        refreshStarted = true;
        return refreshGate.then(() => json({ chapters: serverChapters }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<SongRequestsPanel channelId={channelId} pageId="chapters" language="en" canManage canOperate />);
    fireEvent.click(await screen.findByRole("link", { name: /Night Drive/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Chapter name" }), { target: { value: "Night Drive edited" } });
    fireEvent.click(screen.getByRole("link", { name: /Daybreak/u }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));

    await waitFor(() => { expect(patchCompleted).toBe(true); });
    await waitFor(() => { expect(refreshStarted).toBe(true); });
    expect(screen.getByRole("textbox", { name: "Chapter name" })).toHaveValue("Daybreak");
    releaseRefresh?.();
    await waitFor(() => { expect(screen.getByRole("textbox", { name: "Chapter name" })).toHaveValue("Daybreak"); });
  });

  it("lists offered chapters in the cockpit and starts the selected chapter action", async () => {
    const offered = chapter();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname.endsWith("/connection")) return Promise.resolve(json({ enabled: true, state: "connected", streamId: "stream-fictional", alsoOffline: false }));
      if (url.pathname.endsWith("/chapters/offered")) return Promise.resolve(json({ chapters: [offered] }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    const execute = vi.fn<(formData: FormData) => Promise<void>>(() => Promise.resolve());
    render(<DashboardDataProvider><SongRequestChapterCockpitAction
      channelId={channelId} language="en" onActionExecute={execute}
    /></DashboardDataProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Start chapter" }));
    await waitFor(() => { expect(execute).toHaveBeenCalledTimes(1); });
    expect(execute.mock.calls[0]?.[0].get("chapterId")).toBe(offered.id);
  });

  it("maps a 409 chapter draw error to the cockpit's bilingual feedback", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(json({ token: "csrf-fictional" }));
      return Promise.resolve(json({ error: "song_vote_chapter_not_enough_tracks" }, 409));
    });
    vi.stubGlobal("fetch", fetcher);
    const action = songRequestsModule.actions?.find(({ id }) => id === "start-song-chapter-vote");
    if (action === undefined) throw new Error("The chapter cockpit action is not registered.");
    const formData = new FormData();
    formData.set("chapterId", "chapter-night-drive");

    const result = await action.execute({ channelId, formData } as Parameters<typeof action.execute>[0]);

    expect(result).toMatchObject({ tone: "error", message: {
      en: "This chapter has fewer than two eligible tracks. Add tracks or check the cooldown.",
      de: "Dieses Kapitel hat weniger als zwei verfügbare Songs. Ergänze Tracks oder prüfe die Abklingzeit.",
    } });
  });

  it("defaults recap to the latest stream, lets the viewer switch streams, and links tracks to Spotify", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === `/api/channels/${channelId}/settings`) return Promise.resolve(json({
        timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/recap/streams")) return Promise.resolve(json({
        selectedStreamId: "stream-new",
        streams: [
          { streamId: "stream-new", latestAt: "2026-11-18T19:00:00.000Z", playedCount: 1 },
          { streamId: "stream-old", latestAt: "2026-11-17T19:00:00.000Z", playedCount: 1 },
        ],
      }));
      if (url.pathname.endsWith("/recap")) {
        const old = url.searchParams.get("streamId") === "stream-old";
        return Promise.resolve(json({ streamId: old ? "stream-old" : "stream-new", requests: [{
          requestId: old ? "request-old" : "request-new",
          observedAt: old ? "2026-11-17T19:00:00.000Z" : "2026-11-18T19:00:00.000Z",
          title: old ? "Quiet Atlas" : "Glass Harbor",
          artists: ["Mira Vale"],
          spotifyUrl: old ? "https://open.spotify.com/track/quietatlas02" : "https://open.spotify.com/track/glassharbor01",
          requester: old ? "Song vote" : "Aurora Viewer",
        }] }));
      }
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<DashboardDataProvider><SongRequestsPanel channelId={channelId} pageId="recap" language="en" canManage canOperate /></DashboardDataProvider>);
    const latestLink = await screen.findByRole("link", { name: /Glass Harbor/u });
    expect(latestLink).toHaveAttribute("href", "https://open.spotify.com/track/glassharbor01");
    const picker = screen.getByRole("combobox", { name: "Stream" });
    expect(picker).toHaveTextContent("Nov 18, 2026");
    fireEvent.click(picker);
    clickSelectOption(await screen.findByRole("option", { name: /Nov 17, 2026/u }));
    const previousLink = await screen.findByRole("link", { name: /Quiet Atlas/u });
    expect(previousLink).toHaveAttribute("href", "https://open.spotify.com/track/quietatlas02");
    expect(screen.getAllByText("Song vote").length).toBeGreaterThan(0);
  });

  it("refetches both recap queries when the recap resource revision changes", async () => {
    let recapRevision = 1;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = urlOf(input);
      if (url.pathname === `/api/channels/${channelId}/revisions`) {
        return Promise.resolve(json({ revisions: { "module:song_requests:recap": recapRevision } }));
      }
      if (url.pathname === `/api/channels/${channelId}/settings`) return Promise.resolve(json({
        timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 0,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/recap/streams")) return Promise.resolve(json({
        selectedStreamId: "stream-new",
        streams: [{ streamId: "stream-new", latestAt: "2026-11-18T19:00:00.000Z", playedCount: 1 }],
      }));
      if (url.pathname.endsWith("/recap")) return Promise.resolve(json({ streamId: "stream-new", requests: [{
        requestId: `request-${String(recapRevision)}`,
        observedAt: "2026-11-18T19:00:00.000Z",
        title: "Glass Harbor",
        artists: ["Mira Vale"],
        spotifyUrl: "https://open.spotify.com/track/glassharbor01",
        requester: "Aurora Viewer",
      }] }));
      return Promise.resolve(json({}));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(
      <SongRequestsPanel channelId={channelId} pageId="recap" language="en" canManage canOperate />,
    );
    await screen.findByRole("link", { name: /Glass Harbor/u });
    const requestCount = (suffix: string): number => fetcher.mock.calls.filter(([input]) => urlOf(input).pathname.endsWith(suffix)).length;
    const firstStreamsCount = requestCount("/recap/streams");
    const firstRecapCount = requestCount("/recap");

    await reconcileDashboardPanelResourceRevisions(queryClient, channelId);
    await waitFor(() => {
      expect(requestCount("/recap/streams")).toBe(firstStreamsCount + 1);
      expect(requestCount("/recap")).toBe(firstRecapCount + 1);
    });
    recapRevision = 2;
    await reconcileDashboardPanelResourceRevisions(queryClient, channelId);

    await waitFor(() => {
      expect(requestCount("/recap/streams")).toBe(firstStreamsCount + 2);
      expect(requestCount("/recap")).toBe(firstRecapCount + 2);
    });
  });
});
