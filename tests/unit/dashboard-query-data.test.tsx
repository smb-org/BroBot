import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelApiError } from "../../src/dashboard/api";
import { createDashboardQueryClient } from "../../src/dashboard/data/client";
import { moduleQueryKey, runModuleQueryWrite, useModuleQuery } from "../../src/dashboard/data";
import { queryKeys } from "../../src/dashboard/data/keys";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { emptyAuditFilter } from "../../src/dashboard/audit/model";
import { emptyEventFilter } from "../../src/dashboard/events/model";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-a";

afterEach(() => {
  vi.unstubAllGlobals();
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
      "modules/faq/panel",
    ]);
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

  it("keeps a higher cached module revision when a later read returns older data", async () => {
    let readCount = 0;
    function RevisionProbe() {
      const query = useModuleQuery(channelId, "sun", "error-texts", () => {
        readCount += 1;
        return Promise.resolve(readCount === 1 ? { revision: 2, value: "new" } : { revision: 1, value: "old" });
      });
      return <><p>{query.data?.value ?? "loading"}</p><button onClick={() => { void query.refetch(); }}>Refresh</button></>;
    }
    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 0 });

    await waitFor(() => expect(view.container).toHaveTextContent("new"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(readCount).toBe(2));
    await waitFor(() => expect(view.container).toHaveTextContent("new"));
    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "sun", "error-texts"))).toEqual({ revision: 2, value: "new" });
  });

  it("preserves newer revisions inside module list responses", async () => {
    let readCount = 0;
    function RevisionListProbe() {
      const query = useModuleQuery(channelId, "faq", "panel", () => {
        readCount += 1;
        return Promise.resolve(readCount === 1
          ? { entries: [{ id: "entry-a", revision: 2, answer: "new" }] }
          : { entries: [{ id: "entry-a", revision: 1, answer: "old" }, { id: "entry-b", revision: 1, answer: "other" }] });
      });
      return <p>{query.data?.entries.map((entry) => entry.answer).join(",") ?? "loading"}</p>;
    }

    const view = renderWithQuery(<RevisionListProbe />, {}, { gcTime: 600_000, staleTime: 0 });
    expect(await screen.findByText("new")).toBeInTheDocument();
    const key = moduleQueryKey(channelId, "faq", "panel");
    await act(async () => { await view.queryClient.refetchQueries({ queryKey: key, exact: true }); });

    expect(view.queryClient.getQueryData(key)).toEqual({
      entries: [
        { id: "entry-a", revision: 2, answer: "new" },
        { id: "entry-b", revision: 1, answer: "other" },
      ],
    });
    view.unmount();
  });

  it("checks the latest cached module revision after a read resolves", async () => {
    let resolveRead: ((value: { revision: number; value: string }) => void) | undefined;
    function RevisionProbe() {
      const query = useModuleQuery(channelId, "sun", "error-texts", () => new Promise<{ revision: number; value: string }>((resolve) => { resolveRead = resolve; }));
      return <p>{query.data?.value ?? "loading"}</p>;
    }
    const view = renderWithQuery(<RevisionProbe />, {}, { gcTime: 600_000, staleTime: 0 });
    const key = moduleQueryKey(channelId, "sun", "error-texts");

    await waitFor(() => expect(resolveRead).toBeDefined());
    act(() => { view.queryClient.setQueryData(key, { revision: 2, value: "new" }); });
    act(() => { resolveRead?.({ revision: 1, value: "old" }); });

    await waitFor(() => expect(view.queryClient.getQueryData(key)).toEqual({ revision: 2, value: "new" }));
    expect(view.container).toHaveTextContent("new");
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
