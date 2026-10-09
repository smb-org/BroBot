import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { AuditPage } from "../../src/dashboard/audit/AuditPage";
import { emptyAuditFilter } from "../../src/dashboard/audit/model";
import type { PanelAuditEntry, PanelAuditResponse } from "../../src/panel-contract";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { renderWithQuery } from "../query-test-utils";

const entry = (overrides: Partial<PanelAuditEntry>): PanelAuditEntry => ({
  auditId: "audit-1",
  actorUserId: "user-1",
  actorLogin: null,
  actorDisplayName: "Alice",
  actorKind: "member",
  createdAt: "2026-09-26T10:00:00.000Z",
  moduleId: null,
  action: "member.role_changed",
  before: JSON.stringify({ role: "manager" }),
  after: JSON.stringify({ role: "operator" }),
  subjectUserId: "user-2",
  subjectLogin: "bob",
  subjectDisplayName: "Bob",
  ...overrides,
});

const renderPage = (entries: readonly PanelAuditEntry[]) => {
  const response: PanelAuditResponse = { entries: [...entries], nextCursor: null };
  return renderWithQuery(
    <UiProvider>
      <AuditPage
        channelId="channel-a"
        filters={emptyAuditFilter}
        onFiltersChange={() => undefined}
      />
    </UiProvider>,
    undefined,
    { initialData: [{ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), data: { pages: [response], pageParams: [null] } }] },
  );
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // `dashboardLanguage()` reads `navigator.language`; reset it to the suite
  // default (`tests/setup.ts`) so an English test doesn't leak into the next.
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
});

describe("AuditPage diff list", () => {
  it("localizes a member's role values in the expanded diff, not just the feed sentence (#254 review)", async () => {
    renderPage([entry({})]);

    fireEvent.click(await screen.findByRole("button", { name: /Verwalter zu Bediener/u }));

    const diffRow = screen.getByText("Rolle").closest(".audit-diff__row");
    expect(diffRow).not.toBeNull();
    expect(diffRow).toHaveTextContent("Verwalter");
    expect(diffRow).toHaveTextContent("Bediener");
    expect(diffRow).not.toHaveTextContent("manager");
    expect(diffRow).not.toHaveTextContent("operator");
  });

  it("keeps the person search focused when the filter query changes", async () => {
    const initialEntry = entry({});
    const response: PanelAuditResponse = { entries: [initialEntry], nextCursor: null };
    let releaseFilteredResponse: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { releaseFilteredResponse = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    function Harness() {
      const [filters, setFilters] = useState(emptyAuditFilter);
      return <AuditPage channelId="channel-a" filters={filters} onFiltersChange={setFilters} />;
    }

    renderWithQuery(
      <UiProvider><Harness /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        initialData: [{ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), data: { pages: [response], pageParams: [null] } }],
      },
    );
    const personSearch = screen.getByRole("textbox", { name: "Person" });
    personSearch.focus();
    fireEvent.change(personSearch, { target: { value: "alice" } });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(document.activeElement).toBe(personSearch);
    expect(screen.getByRole("button", { name: /Alice.*Bob/u })).toBeVisible();
    expect(document.querySelector(".audit-sentence-list")?.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    releaseFilteredResponse?.(new Response(JSON.stringify({ entries: [], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });

  it("restores a warm filter cache before requesting again", async () => {
    const initialEntry = entry({ auditId: "audit-unfiltered" });
    const filteredEntry = entry({ auditId: "audit-filtered", actorDisplayName: "Bea", subjectDisplayName: "Cara" });
    const initialResponse: PanelAuditResponse = { entries: [initialEntry], nextCursor: null };
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: [filteredEntry], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetcher);

    function Harness() {
      const [filters, setFilters] = useState(emptyAuditFilter);
      return <>
        <button type="button" onClick={() => { setFilters(filters.area === null ? { ...filters, area: "member" } : emptyAuditFilter); }}>Toggle member filter</button>
        <AuditPage channelId="channel-a" filters={filters} onFiltersChange={setFilters} />
      </>;
    }

    renderWithQuery(
      <UiProvider><Harness /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), data: { pages: [initialResponse], pageParams: [null] } }],
      },
    );
    expect(screen.getByRole("button", { name: /Alice.*Bob/u })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Toggle member filter" }));
    expect(await screen.findByRole("button", { name: /Bea.*Cara/u })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Toggle member filter" }));

    expect(screen.getByRole("button", { name: /Alice.*Bob/u })).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows a Retry action for an initial query error and recovers through the query", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><AuditPage channelId="channel-a" filters={emptyAuditFilter} onFiltersChange={() => undefined} /></UiProvider>);

    const retry = await screen.findByRole("button", { name: "Erneut versuchen" });
    fireEvent.click(retry);
    expect(await screen.findByText("Noch keine Audit-Einträge gespeichert.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps cached audit rows visible and offers Retry after a background failure", async () => {
    const cachedEntry = entry({});
    const refreshedEntry = entry({ auditId: "audit-recovered", actorDisplayName: "Bea", subjectDisplayName: "Cara" });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [refreshedEntry], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    const rendered = renderWithQuery(
      <UiProvider><AuditPage channelId="channel-a" filters={emptyAuditFilter} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter),
          data: { pages: [{ entries: [cachedEntry], nextCursor: null }], pageParams: [null] },
        }],
      },
    );

    expect(screen.getByRole("button", { name: /Alice.*Bob/u })).toBeVisible();
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), exact: true });
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rendered.queryClient.getQueryState(dashboardDataKeys.audit("channel-a", emptyAuditFilter))?.status).toBe("error");
    expect(screen.getByRole("button", { name: /Alice.*Bob/u })).toBeVisible();
    await waitFor(() => expect(rendered.container.querySelector(".query-status-row")?.textContent).toContain("Erneut versuchen"));
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByRole("button", { name: /Bea.*Cara/u })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Erneut versuchen" })).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
