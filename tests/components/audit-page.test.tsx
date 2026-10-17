import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { AuditPage } from "../../src/dashboard/audit/AuditPage";
import { emptyAuditFilter } from "../../src/dashboard/audit/model";
import type { PanelAuditEntry, PanelAuditResponse } from "../../src/panel-contract";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { renderWithQuery as renderWithQueryBase, type DashboardQueryTestOptions } from "../query-test-utils";
import type { RenderOptions } from "@testing-library/react";

const renderWithQuery = (
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
  queryOptions: DashboardQueryTestOptions = {},
): ReturnType<typeof renderWithQueryBase> => renderWithQueryBase(ui, options, {
  ...queryOptions,
  initialData: [
    ...(queryOptions.initialData ?? []),
    { queryKey: ["channel", "channel-a", "settings"], data: { timeZone: "Europe/Berlin", revision: 1 } },
  ],
});

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
      <div className="dashboard-shell__main">
        <AuditPage
          channelId="channel-a"
          filters={emptyAuditFilter}
          onFiltersChange={() => undefined}
        />
      </div>
    </UiProvider>,
    undefined,
    { staleTime: 30_000, initialData: [{ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), data: { pages: [response], pageParams: [null] } }] },
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
  it("keeps pagination and filters above the growing audit table", () => {
    const { container } = renderPage([entry({}), entry({ auditId: "audit-2", createdAt: "2026-09-25T10:00:00.000Z" })]);
    const filters = container.querySelector(".audit-filter");
    const pagination = container.querySelector(".audit-pagination");
    const table = container.querySelector(".audit-sentence-list");

    if (filters === null || pagination === null || table === null) throw new Error("The audit list structure should render.");
    expect(filters).not.toBeNull();
    expect(pagination).not.toBeNull();
    expect(table).not.toBeNull();
    expect(filters.compareDocumentPosition(pagination) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pagination.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("holds newly arriving rows outside the reader's current position until they jump to the latest entries", async () => {
    const current = [entry({}), entry({ auditId: "audit-2", createdAt: "2026-09-25T10:00:00.000Z" })];
    const rendered = renderPage(current);
    const scroller = rendered.container.querySelector<HTMLElement>(".dashboard-shell__main");
    const feed = rendered.container.querySelector<HTMLElement>(".audit-page-list");
    if (scroller === null || feed === null) throw new Error("The dashboard scroll container and audit feed should render.");
    vi.spyOn(feed, "getBoundingClientRect").mockReturnValue({ top: -60, bottom: 700, left: 0, right: 800, width: 800, height: 760, x: 0, y: -60, toJSON: () => ({}) });

    act(() => {
      scroller.scrollTop = 560;
      fireEvent.scroll(scroller);
      rendered.queryClient.setQueryData(dashboardDataKeys.audit("channel-a", emptyAuditFilter), {
        pages: [{ entries: [entry({ auditId: "audit-new", actorDisplayName: "Zoe", createdAt: "2026-09-26T11:00:00.000Z" }), ...current], nextCursor: null }],
        pageParams: [null],
      });
    });
    const newEntriesButton = await screen.findByRole("button", { name: /^1 neuer Eintrag/u });

    const rows = rendered.container.querySelectorAll(".audit-sentence-list tbody tr:not(.data-table__day-row)");
    expect(rows[0]).toHaveTextContent("Alice");
    expect(scroller.scrollTop).toBe(560);
    fireEvent.click(newEntriesButton);

    await waitFor(() => expect(rendered.container.querySelector(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveTextContent("Zoe"));
  });

  it("holds a realtime insertion while the reader is at the top of the log", async () => {
    const current = [entry({}), entry({ auditId: "audit-2", createdAt: "2026-09-25T10:00:00.000Z" })];
    const rendered = renderPage(current);
    const result = rendered.queryClient.getQueryData<{ pages: Array<{ entries: PanelAuditEntry[]; nextCursor: null }>; pageParams: [null] }>(dashboardDataKeys.audit("channel-a", emptyAuditFilter));
    if (result === undefined) throw new Error("Audit query data is missing.");
    act(() => {
      rendered.queryClient.setQueryData(dashboardDataKeys.audit("channel-a", emptyAuditFilter), {
        ...result,
        pages: [{ ...result.pages[0]!, entries: [entry({ auditId: "audit-new", actorDisplayName: "Zoe", createdAt: "2026-09-26T11:00:00.000Z" }), ...current] }],
      });
    });

    expect(rendered.container.querySelector(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveTextContent("Alice");
    expect(await screen.findByRole("button", { name: /^1 neuer Eintrag/u })).toBeVisible();
  });

  it("appends audit pages with equal cursor timestamps without dropping boundary rows", async () => {
    const latest = entry({ auditId: "audit-latest", createdAt: "2026-09-26T11:00:00.000Z", actorDisplayName: "Mira" });
    const boundary = entry({ auditId: "audit-z", createdAt: "2026-09-26T10:00:00.000Z", actorDisplayName: "Bea" });
    const sameTimestampOlderId = entry({ auditId: "audit-a", createdAt: boundary.createdAt, actorDisplayName: "Cara" });
    const rendered = renderPage([latest, boundary]);
    const scroller = rendered.container.querySelector<HTMLElement>(".dashboard-shell__main");
    const feed = rendered.container.querySelector<HTMLElement>(".audit-page-list");
    if (scroller === null || feed === null) throw new Error("The dashboard scroll container and audit feed should render.");
    vi.spyOn(feed, "getBoundingClientRect").mockReturnValue({ top: -60, bottom: 700, left: 0, right: 800, width: 800, height: 760, x: 0, y: -60, toJSON: () => ({}) });
    act(() => {
      scroller.scrollTop = 560;
      fireEvent.scroll(scroller);
      rendered.queryClient.setQueryData(dashboardDataKeys.audit("channel-a", emptyAuditFilter), {
        pages: [
          { entries: [latest, boundary], nextCursor: "cursor-older" },
          { entries: [sameTimestampOlderId], nextCursor: null },
        ],
        pageParams: [null, "cursor-older"],
      });
    });

    await waitFor(() => expect(rendered.container.querySelectorAll(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveLength(3));
    expect(rendered.container.querySelector(".audit-sentence-list tbody tr:last-child")).toHaveTextContent("Cara");
  });

  it("keeps newly arrived entries pending when an older page includes them ahead of the snapshot boundary", async () => {
    const latest = entry({ auditId: "audit-latest", createdAt: "2026-09-26T11:00:00.000Z", actorDisplayName: "Mira" });
    const boundary = entry({ auditId: "audit-z", createdAt: "2026-09-26T10:00:00.000Z", actorDisplayName: "Bea" });
    const pendingNewer = entry({ auditId: "audit-newer", createdAt: "2026-09-26T10:30:00.000Z", actorDisplayName: "Nora" });
    const equalTimestampOlderId = entry({ auditId: "audit-a", createdAt: boundary.createdAt, actorDisplayName: "Cara" });
    const older = entry({ auditId: "audit-old", createdAt: "2026-09-26T09:00:00.000Z", actorDisplayName: "Otto" });
    const rendered = renderPage([latest, boundary]);
    const scroller = rendered.container.querySelector<HTMLElement>(".dashboard-shell__main");
    const feed = rendered.container.querySelector<HTMLElement>(".audit-page-list");
    if (scroller === null || feed === null) throw new Error("The dashboard scroll container and audit feed should render.");
    vi.spyOn(feed, "getBoundingClientRect").mockReturnValue({ top: -60, bottom: 700, left: 0, right: 800, width: 800, height: 760, x: 0, y: -60, toJSON: () => ({}) });
    act(() => {
      scroller.scrollTop = 560;
      fireEvent.scroll(scroller);
      rendered.queryClient.setQueryData(dashboardDataKeys.audit("channel-a", emptyAuditFilter), {
        pages: [
          { entries: [latest, boundary], nextCursor: "cursor-older" },
          { entries: [pendingNewer, boundary, equalTimestampOlderId, older], nextCursor: null },
        ],
        pageParams: [null, "cursor-older"],
      });
    });

    await waitFor(() => expect(rendered.container.querySelectorAll(".audit-sentence-list tbody tr:not(.data-table__day-row)")).toHaveLength(4));
    const sentences = [...rendered.container.querySelectorAll(".audit-sentence")].map((sentence) => sentence.textContent);
    expect(sentences.some((sentence) => sentence?.includes("Nora"))).toBe(false);
    expect(sentences.some((sentence) => sentence?.includes("Cara"))).toBe(true);
    expect(sentences.some((sentence) => sentence?.includes("Otto"))).toBe(true);
    expect(await screen.findByRole("button", { name: /^1 neuer Eintrag/u })).toBeVisible();
  });

  it("localizes a member's role values in the expanded diff, not just the feed sentence (#254 review)", async () => {
    renderPage([entry({})]);

    const sentence = await screen.findByText(/Verwalter zu Bediener/u, { selector: ".audit-sentence" });
    const row = sentence.closest("tr");
    if (row === null) throw new Error("Audit row is missing.");
    fireEvent.click(row);

    const diffRow = screen.getByText("Rolle").closest(".audit-diff__row");
    expect(diffRow).not.toBeNull();
    expect(diffRow).toHaveTextContent("Verwalter");
    expect(diffRow).toHaveTextContent("Bediener");
    expect(diffRow).not.toHaveTextContent("manager");
    expect(diffRow).not.toHaveTextContent("operator");
  });

  it("keeps the person search focused when the filter query changes", async () => {
    const initialEntry = entry({});
    const filteredEntry = entry({ auditId: "audit-filtered", actorDisplayName: "Bea", subjectDisplayName: "Cara" });
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
    expect(screen.queryByText(/Alice.*Bob/u, { selector: ".audit-sentence" })).not.toBeInTheDocument();
    releaseFilteredResponse?.(new Response(JSON.stringify({ entries: [filteredEntry], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await screen.findByText(/Bea.*Cara/u, { selector: ".audit-sentence" })).toBeVisible();
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
    expect(screen.getByText(/Alice.*Bob/u, { selector: ".audit-sentence" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Toggle member filter" }));
    expect(await screen.findByText(/Bea.*Cara/u, { selector: ".audit-sentence" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Toggle member filter" }));

    expect(screen.getByText(/Alice.*Bob/u, { selector: ".audit-sentence" })).toBeVisible();
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

    expect(screen.getByText(/Alice.*Bob/u, { selector: ".audit-sentence" })).toBeVisible();
    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: dashboardDataKeys.audit("channel-a", emptyAuditFilter), exact: true });
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(rendered.queryClient.getQueryState(dashboardDataKeys.audit("channel-a", emptyAuditFilter))?.status).toBe("error");
    expect(screen.getByText(/Alice.*Bob/u, { selector: ".audit-sentence" })).toBeVisible();
    await waitFor(() => expect(rendered.container.querySelector(".audit-request-error")).not.toBeNull());
    const retry = rendered.container.querySelector<HTMLButtonElement>(".audit-request-error button");
    expect(retry).toBeVisible();
    fireEvent.click(retry as HTMLButtonElement);

    expect(await screen.findByText(/Bea.*Cara/u, { selector: ".audit-sentence" })).toBeVisible();
    expect(rendered.container.querySelector(".audit-request-error")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
