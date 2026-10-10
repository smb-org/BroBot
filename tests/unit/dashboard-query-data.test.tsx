import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelApiError } from "../../src/dashboard/api";
import { createDashboardQueryClient } from "../../src/dashboard/data/client";
import { moduleQueryKey, refetchModuleQueryData, runModuleQueryWrite, useModuleQuery } from "../../src/dashboard/data";
import { queryKeys } from "../../src/dashboard/data/keys";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus, useDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { useOverlayQuery } from "../../src/dashboard/data/lists";
import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { emptyAuditFilter } from "../../src/dashboard/audit/model";
import { emptyEventFilter } from "../../src/dashboard/events/model";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-a";

afterEach(() => {
  vi.unstubAllGlobals();
  setDashboardRealtimeStatus(channelId, "offline");
});

describe("dashboard query data layer", () => {
  it("keeps every channel resource key rooted at its channel ID", () => {
    expect(queryKeys.channel(channelId, "events", { cursor: "cursor /?#&", tone: "error" })).toEqual([
      "channel",
      channelId,
      "events",
      { cursor: "cursor /?#&", tone: "error" },
    ]);
  });

  it("includes audit and event filters in their channel-scoped list keys", () => {
    expect(dashboardDataKeys.audit(channelId, { person: "alice", area: "member" })).toEqual([
      "channel", channelId, "audit-log", { person: "alice", area: "member" },
    ]);
    expect(dashboardDataKeys.audit(channelId, emptyAuditFilter)).not.toEqual(
      dashboardDataKeys.audit(channelId, { person: "alice", area: "member" }),
    );
    expect(dashboardDataKeys.events(channelId, { ...emptyEventFilter, origin: "channel" })).toEqual([
      "channel", channelId, "events", { origin: "channel", module: null, tone: null, tones: null, person: null },
    ]);
    expect(dashboardDataKeys.events(channelId, emptyEventFilter)).not.toEqual(
      dashboardDataKeys.events(channelId, { ...emptyEventFilter, origin: "channel" }),
    );
  });

  it("keeps module query keys scoped to their channel, module, and part", () => {
    expect(moduleQueryKey(channelId, "faq", "panel")).toEqual([
      "channel",
      channelId,
      "module",
      "faq",
      "panel",
    ]);
  });

  it("stops fallback interval reads as soon as the channel socket connects", async () => {
    let readCount = 0;
    function Probe() {
      const status = useDashboardRealtimeStatus(channelId);
      const query = useModuleQuery(channelId, "chat_voting", "panel", () => {
        readCount += 1;
        return Promise.resolve(readCount);
      }, { refetchInterval: status === "connected" ? false : 20 });
      return <p>{String(query.data ?? "loading")}</p>;
    }

    const view = renderWithQuery(<Probe />, {}, { gcTime: 600_000, staleTime: 0 });
    expect(await screen.findByText("1")).toBeInTheDocument();
    act(() => { setDashboardRealtimeStatus(channelId, "connected"); });
    await new Promise((resolve) => { setTimeout(resolve, 100); });

    expect(readCount).toBe(1);
    view.unmount();
  });

  it("uses the fallback interval while the channel socket is offline", async () => {
    let readCount = 0;
    function Probe() {
      const status = useDashboardRealtimeStatus(channelId);
      const query = useModuleQuery(channelId, "votekick", "panel", () => {
        readCount += 1;
        return Promise.resolve(readCount);
      }, { refetchInterval: status === "connected" ? false : 20 });
      return <p>{String(query.data ?? "loading")}</p>;
    }

    const view = renderWithQuery(<Probe />, {}, { gcTime: 600_000, staleTime: 0 });
    await waitFor(() => expect(readCount).toBeGreaterThan(1));

    expect(readCount).toBeGreaterThan(1);
    view.unmount();
  });

  it("does not show a previous overlay while another overlay is loading", async () => {
    let releaseOverlayB: (() => void) | undefined;
    let markOverlayBStarted: (() => void) | undefined;
    const overlayBStarted = new Promise<void>((resolve) => { markOverlayBStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const overlayId = new URL(requestUrl, window.location.href).pathname.split("/").at(-1);
      if (overlayId === "overlay-a") {
        return new Response(JSON.stringify({ overlay: { id: overlayId, name: "Overlay A" } }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      markOverlayBStarted?.();
      await new Promise<void>((resolve) => { releaseOverlayB = resolve; });
      return new Response(JSON.stringify({ overlay: { id: overlayId, name: "Overlay B" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }));

    function OverlayProbe({ overlayId }: { overlayId: string }) {
      const query = useOverlayQuery(channelId, overlayId);
      return <p>{query.data?.overlay.name ?? "Loading"}</p>;
    }

    const view = renderWithQuery(<OverlayProbe overlayId="overlay-a" />);
    expect(await screen.findByText("Overlay A")).toBeInTheDocument();

    view.rerender(<OverlayProbe overlayId="overlay-b" />);
    await overlayBStarted;

    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("Overlay A")).not.toBeInTheDocument();
    releaseOverlayB?.();
    expect(await screen.findByText("Overlay B")).toBeInTheDocument();
    view.unmount();
  });

  it("queues one trailing read when realtime hints arrive during an active refresh", async () => {
    let readCount = 0;
    let releaseRefresh: (() => void) | undefined;
    let markRefreshStarted: (() => void) | undefined;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    function ModuleProbe() {
      const query = useModuleQuery(channelId, "chat_voting", "panel", async () => {
        readCount += 1;
        if (readCount === 2) {
          markRefreshStarted?.();
          await new Promise<void>((resolve) => { releaseRefresh = resolve; });
        }
        return readCount;
      });
      return <p>{String(query.data ?? "Loading")}</p>;
    }

    const view = renderWithQuery(<ModuleProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("1")).toBeInTheDocument();
    let revision = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: { "module:chat_voting:panel": revision } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }))));
    await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);
    revision = 1;
    await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);
    await refreshStarted;
    revision = 2;
    await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);
    revision = 3;
    await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);
    expect(readCount).toBe(2);

    releaseRefresh?.();
    await waitFor(() => expect(readCount).toBe(3), { timeout: 2_000 });
    await waitFor(() => expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "chat_voting", "panel"))).toBe(3), { timeout: 2_000 });
    view.unmount();
  });

  it("throttles sustained realtime hints when each read finishes quickly", async () => {
    let readCount = 0;
    function ModuleProbe() {
      const query = useModuleQuery(channelId, "chat_voting", "panel", () => {
        readCount += 1;
        return Promise.resolve(readCount);
      });
      return <p>{String(query.data ?? "Loading")}</p>;
    }

    const view = renderWithQuery(<ModuleProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("1")).toBeInTheDocument();
    let revision = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ revisions: { "module:chat_voting:panel": revision } }), {
      status: 200, headers: { "Content-Type": "application/json" },
    }))));
    await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);

    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      revision += 1;
      await reconcileDashboardPanelResourceRevisions(view.queryClient, channelId);
    }
    await new Promise((resolve) => { setTimeout(resolve, 300); });

    // One immediate refresh plus one trailing refresh for the sustained hint burst.
    expect(readCount).toBe(3);
    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "chat_voting", "panel"))).toBe(readCount);
    view.unmount();
  });

  it("does not let a read started before a module write replace the refetched value", async () => {
    let resolveOldRead: ((value: string) => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    let readCount = 0;
    const firstReadStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });

    function ModuleQueryProbe() {
      const query = useModuleQuery(channelId, "faq", "panel", async (signal) => {
        readCount += 1;
        if (readCount === 1) {
          oldSignal = signal;
          markReadStarted?.();
          return new Promise<string>((resolve) => { resolveOldRead = resolve; });
        }
        return "revision-2";
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<ModuleQueryProbe />, {}, { gcTime: 600_000, staleTime: 0 });
    await firstReadStarted;
    await runModuleQueryWrite(view.queryClient, channelId, "faq", "panel", () => Promise.resolve(undefined), {
      baselineRevision: null,
      updateCache: (current) => current,
    });
    resolveOldRead?.("revision-1");

    expect(await screen.findByText("revision-2")).toBeInTheDocument();
    await waitFor(() => expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "faq", "panel"))).toBe("revision-2"));
    expect(oldSignal?.aborted).toBe(true);
  });

  it("applies late write responses in request order so a deleted entry stays deleted", async () => {
    let readCount = 0;
    let releaseMove: (() => void) | undefined;
    const moveReleased = new Promise<void>((resolve) => { releaseMove = resolve; });

    function ListProbe() {
      const query = useModuleQuery<string[]>(channelId, "faq", "panel", () => {
        readCount += 1;
        return readCount === 1 ? Promise.resolve(["a", "b", "c"]) : Promise.reject(new Error("revalidation failed"));
      });
      return <p>{query.data?.join(",") ?? "loading"}</p>;
    }

    const view = renderWithQuery(<ListProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("a,b,c")).toBeInTheDocument();

    const move = runModuleQueryWrite(view.queryClient, channelId, "faq", "panel",
      async () => { await moveReleased; return ["b", "a", "c"]; },
      { baselineRevision: 1, updateCache: (_current, result: string[]) => result });
    const remove = runModuleQueryWrite(view.queryClient, channelId, "faq", "panel",
      () => Promise.resolve("c"),
      { baselineRevision: 1, updateCache: (current, id: string) => (current as string[]).filter((item) => item !== id) });
    // Without a queue the delete would finish while the move response is still held back.
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    releaseMove?.();
    await Promise.all([move, remove]);

    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "faq", "panel"))).toEqual(["b", "a"]);
  });

  it("never accepts cached data for a reload that a write would have cancelled", async () => {
    let readCount = 0;
    let releaseReload: (() => void) | undefined;
    const reloadReleased = new Promise<void>((resolve) => { releaseReload = resolve; });

    function CommandsProbe() {
      const query = useModuleQuery<string>(channelId, "text_commands", "commands", async () => {
        readCount += 1;
        if (readCount === 2) await reloadReleased;
        return `server-${String(readCount)}`;
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<CommandsProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("server-1")).toBeInTheDocument();

    const reload = refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands");
    await waitFor(() => expect(readCount).toBe(2));
    const toggle = runModuleQueryWrite(view.queryClient, channelId, "text_commands", "commands",
      () => Promise.resolve("toggled"),
      { baselineRevision: 1, updateCache: (current) => current });
    releaseReload?.();

    await expect(reload).resolves.toBe("server-2");
    await toggle;
  });

  it("resolves a reload with the fresh server value even when the key's queries are cancelled", async () => {
    let readCount = 0;
    let releaseReload: (() => void) | undefined;
    let failReload = false;
    const reloadReleased = new Promise<void>((resolve) => { releaseReload = resolve; });

    function RevisionProbe() {
      const query = useModuleQuery<string>(channelId, "text_commands", "commands", async () => {
        readCount += 1;
        if (readCount === 2) {
          await reloadReleased;
          if (failReload) throw new Error("server unreachable");
        }
        return `revision-${String(readCount)}`;
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("revision-1")).toBeInTheDocument();
    const key = moduleQueryKey(channelId, "text_commands", "commands");

    const reload = refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands");
    await waitFor(() => expect(readCount).toBe(2));
    await view.queryClient.cancelQueries({ queryKey: key, exact: true });
    releaseReload?.();

    await expect(reload).resolves.toBe("revision-2");
    expect(view.queryClient.getQueryData(key)).toBe("revision-2");

    // A failed read rejects so the caller keeps its draft and conflict state.
    readCount = 1;
    failReload = true;
    await expect(refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands"))
      .rejects.toThrow("server unreachable");
    expect(view.queryClient.getQueryData(key)).toBe("revision-2");
  });

  it("does not regress the cache when a reload returns after a newer background read", async () => {
    let readCount = 0;
    let releaseReload: (() => void) | undefined;
    const reloadReleased = new Promise<void>((resolve) => { releaseReload = resolve; });

    function RevisionProbe() {
      const query = useModuleQuery<string>(channelId, "text_commands", "commands", async () => {
        readCount += 1;
        const mine = readCount;
        if (mine === 2) await reloadReleased;
        return `revision-${String(mine)}`;
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("revision-1")).toBeInTheDocument();
    const key = moduleQueryKey(channelId, "text_commands", "commands");

    const reload = refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands");
    await waitFor(() => expect(readCount).toBe(2));
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    // A focus-style refetch completes with revision 3 while the reload is held back.
    await view.queryClient.refetchQueries({ queryKey: key, exact: true });
    expect(view.queryClient.getQueryData(key)).toBe("revision-3");
    releaseReload?.();

    await expect(reload).resolves.toBe("revision-3");
    expect(view.queryClient.getQueryData(key)).toBe("revision-3");
  });

  it("keeps a reload's newer revision when an older background read finishes during it", async () => {
    let readCount = 0;
    const releases = new Map<number, () => void>();

    function RevisionProbe() {
      const query = useModuleQuery<string>(channelId, "text_commands", "commands", async () => {
        readCount += 1;
        const mine = readCount;
        if (mine >= 2) await new Promise<void>((resolve) => { releases.set(mine, resolve); });
        return `revision-${String(mine)}`;
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("revision-1")).toBeInTheDocument();
    const key = moduleQueryKey(channelId, "text_commands", "commands");

    // The background read starts first (revision 2), the reload second (revision 3).
    const background = view.queryClient.refetchQueries({ queryKey: key, exact: true });
    await waitFor(() => expect(readCount).toBe(2));
    const reload = refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands");
    await waitFor(() => expect(readCount).toBe(3));

    // The older background read finishes while the reload is still in flight.
    releases.get(2)?.();
    await background;
    // The reload cancelled the older cache read, so it cannot commit revision 2.
    expect(view.queryClient.getQueryData(key)).toBe("revision-1");
    releases.get(3)?.();

    await expect(reload).resolves.toBe("revision-3");
    expect(view.queryClient.getQueryData(key)).toBe("revision-3");
  });

  it("keeps a reload's revision when an older background read resolves in the same turn", async () => {
    let readCount = 0;
    const releases = new Map<number, () => void>();

    function RevisionProbe() {
      const query = useModuleQuery<string>(channelId, "text_commands", "commands", async () => {
        readCount += 1;
        const mine = readCount;
        if (mine >= 2) await new Promise<void>((resolve) => { releases.set(mine, resolve); });
        return `revision-${String(mine)}`;
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("revision-1")).toBeInTheDocument();
    const key = moduleQueryKey(channelId, "text_commands", "commands");

    const background = view.queryClient.refetchQueries({ queryKey: key, exact: true });
    await waitFor(() => expect(readCount).toBe(2));
    const reload = refetchModuleQueryData<string>(view.queryClient, channelId, "text_commands", "commands");
    await waitFor(() => expect(readCount).toBe(3));

    releases.get(2)?.();
    releases.get(3)?.();
    await expect(reload).resolves.toBe("revision-3");
    await background;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(view.queryClient.getQueryData(key)).toBe("revision-3");
  });

  it("restarts a cancelled cold read when the module write fails", async () => {
    let markReadStarted: (() => void) | undefined;
    let oldSignal: AbortSignal | undefined;
    let readCount = 0;
    const firstReadStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });

    function ModuleQueryProbe() {
      const query = useModuleQuery(channelId, "api_source", "sources", async (signal) => {
        readCount += 1;
        if (readCount === 1) {
          oldSignal = signal;
          markReadStarted?.();
          return new Promise<string>(() => undefined);
        }
        return "recovered";
      });
      return <p>{query.data ?? (query.isPending ? "loading" : "failed")}</p>;
    }

    const view = renderWithQuery(<ModuleQueryProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });
    await firstReadStarted;

    await expect(runModuleQueryWrite(
      view.queryClient,
      channelId,
      "api_source",
      "sources",
      (baselineRevision) => {
        expect(baselineRevision).toBe(4);
        return Promise.reject(new Error("write failed"));
      },
      { baselineRevision: 4, updateCache: (current) => current },
    )).rejects.toThrow("write failed");

    expect(oldSignal?.aborted).toBe(true);
    expect(await screen.findByText("recovered")).toBeInTheDocument();
    expect(readCount).toBe(2);
    view.unmount();
  });

  it("reuses warm module data when a panel is mounted again", async () => {
    let readCount = 0;

    function QueryProbe() {
      const query = useModuleQuery(channelId, "faq", "panel", () => {
        readCount += 1;
        return Promise.resolve("warm data");
      });
      return <p>{query.data ?? "loading"}</p>;
    }

    function Harness() {
      const [mounted, setMounted] = useState(true);
      return <>
        <button onClick={() => setMounted((current) => !current)}>{mounted ? "Leave module" : "Re-enter module"}</button>
        {mounted ? <QueryProbe /> : null}
      </>;
    }

    const view = renderWithQuery(<Harness />, {}, { gcTime: 600_000, staleTime: 600_000 });
    expect(await screen.findByText("warm data")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Leave module" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-enter module" }));

    expect(await screen.findByText("warm data")).toBeInTheDocument();
    expect(screen.queryByText("loading")).not.toBeInTheDocument();
    expect(readCount).toBe(1);
    view.unmount();
  });

  it("accepts a recreated resource revision after a committed write", async () => {
    let readCount = 0;
    function RevisionProbe() {
      const query = useModuleQuery(channelId, "api_source", "sources", () => {
        readCount += 1;
        return Promise.resolve({ sources: [{ name: "sunset", revision: readCount === 1 ? 4 : 1 }] });
      });
      return <p>{query.data?.sources[0]?.revision ?? "loading"}</p>;
    }
    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 600_000 });

    await waitFor(() => expect(view.container).toHaveTextContent("4"));
    const key = moduleQueryKey(channelId, "api_source", "sources");
    await act(async () => {
      await runModuleQueryWrite(view.queryClient, channelId, "api_source", "sources", () => Promise.resolve({
        sources: [{ name: "sunset", revision: 1 }],
      }), {
        baselineRevision: 4,
        updateCache: (_current, result) => result,
      });
    });

    expect(readCount).toBe(2);
    expect(view.queryClient.getQueryData(key)).toEqual({ sources: [{ name: "sunset", revision: 1 }] });
    view.unmount();
  });

  it("invalidates dependent module reads after a write", async () => {
    const view = renderWithQuery(<p>Ready</p>);
    const dependentKey = moduleQueryKey(channelId, "text_commands", "template-variables");
    view.queryClient.setQueryData(dependentKey, [{ name: "text.old", isTextBlock: true }]);

    await runModuleQueryWrite(
      view.queryClient,
      channelId,
      "text_library",
      "library",
      () => Promise.resolve(undefined),
      {
        baselineRevision: null,
        updateCache: (current) => current,
        relatedParts: [{ moduleId: "text_commands", part: "template-variables" }],
      },
    );

    expect(view.queryClient.getQueryState(dependentKey)?.isInvalidated).toBe(true);
    view.unmount();
  });

  it("creates a fresh query client with isolated test defaults for each render", () => {
    const first = renderWithQuery(<p>First test</p>);
    const second = renderWithQuery(<p>Second test</p>);

    expect(first.queryClient).not.toBe(second.queryClient);
    expect(first.queryClient.getDefaultOptions().queries).toMatchObject({ retry: false, gcTime: 0 });

    first.unmount();
    second.unmount();
  });

  it("uses the shared query defaults and skips retries for unauthorized requests", () => {
    const client = createDashboardQueryClient();
    const queryDefaults = client.getDefaultOptions().queries;

    expect(queryDefaults).toMatchObject({
      staleTime: 30_000,
      gcTime: 600_000,
    });
    expect(queryDefaults?.placeholderData).toBe(keepPreviousData);
    expect(typeof queryDefaults?.retry).toBe("function");
    if (typeof queryDefaults?.retry !== "function") throw new Error("Expected a retry callback.");

    expect(queryDefaults.retry(0, new PanelApiError(401, "session_expired"))).toBe(false);
    expect(queryDefaults.retry(0, new Error("temporary failure"))).toBe(true);
    expect(queryDefaults.retry(1, new Error("temporary failure"))).toBe(false);
  });

  it("shows the login state after a query receives a 401", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "session_expired" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetcher);

    function QueryProbe() {
      useQuery({ queryKey: queryKeys.channel(channelId, "overview") });
      return null;
    }

    function Harness() {
      const [authenticationRequired, setAuthenticationRequired] = useState(false);
      return (
        <DashboardDataProvider onAuthenticationRequired={() => setAuthenticationRequired(true)}>
          <UiProvider>
            {authenticationRequired ? <p>Sign in again</p> : <QueryProbe />}
          </UiProvider>
        </DashboardDataProvider>
      );
    }

    render(<Harness />);

    expect(await screen.findByText("Sign in again")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      new URL(`/api/channels/${channelId}/overview`, window.location.origin),
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});
