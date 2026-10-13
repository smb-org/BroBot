import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DataTable, formatRelativeTime } from "../../src/dashboard/ui";

afterEach(() => {
  cleanup();
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
});

describe("DataTable", () => {
  it("groups channel-local days and exposes each exact time as title and accessible label", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const rows = [
      { id: "today", at: "2026-10-13T11:50:00.000Z", moduleGroup: "timers" },
      { id: "yesterday", at: "2026-10-12T07:00:00.000Z", moduleGroup: "host" },
    ];

    render(<DataTable
      ariaLabel="Ereignisprotokoll"
      rows={rows}
      columns={[{ key: "summary", label: "Eintrag", render: (row) => row.id }]}
      timeZone="Europe/Berlin"
      now={now}
      emptyLabel="Keine Einträge"
    />);

    expect(screen.getByText("Heute")).toBeInTheDocument();
    expect(screen.getByText("Gestern")).toBeInTheDocument();
    expect(document.querySelectorAll(".data-table__table tbody tr:not(.data-table__day-row)")).toHaveLength(2);

    const firstRow = rows[0];
    if (firstRow === undefined) throw new Error("First data row is missing.");
    const expectedExact = formatRelativeTime(firstRow.at, now, "de", "Europe/Berlin").exact;
    const time = screen.getByLabelText(expectedExact);
    expect(time).toHaveAttribute("title", expectedExact);
    expect(time).toHaveTextContent("vor 10 Min.");
  });
});
