import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PanelApiError } from "../../src/dashboard/api";
import { createDashboardQueryClient } from "../../src/dashboard/data/client";
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
