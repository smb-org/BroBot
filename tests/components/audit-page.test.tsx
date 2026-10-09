import { cleanup, fireEvent, screen } from "@testing-library/react";
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
});
