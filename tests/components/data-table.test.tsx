import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTable, formatRelativeTime } from "../../src/dashboard/ui";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
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

  it("emits each date once in the order that date first appears", () => {
    const rows = [
      { id: "today-first", at: "2026-10-13T11:50:00.000Z", moduleGroup: "host" },
      { id: "yesterday", at: "2026-10-12T11:50:00.000Z", moduleGroup: "host" },
      { id: "today-again", at: "2026-10-13T10:50:00.000Z", moduleGroup: "host" },
    ];

    const { container } = render(<DataTable
      ariaLabel="Ereignisprotokoll"
      rows={rows}
      columns={[{ key: "summary", label: "Eintrag", render: (row) => row.id }]}
      timeZone="Europe/Berlin"
      now={new Date("2026-10-13T12:00:00.000Z")}
      emptyLabel="Keine Einträge"
    />);

    expect(Array.from(container.querySelectorAll(".data-table__day-row th"), (header) => header.textContent)).toEqual(["Heute", "Gestern"]);
    expect(container.querySelectorAll(".data-table__table tbody")).toHaveLength(2);
    expect(container.querySelectorAll(".data-table__table tbody tr:not(.data-table__day-row)")).toHaveLength(3);
  });

  it("ticks all relative labels from one aligned clock and pauses while hidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T12:00:00.000Z"));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    const rows = [
      { id: "first", at: "2026-10-13T12:00:00.000Z", moduleGroup: "host" },
      { id: "second", at: "2026-10-13T12:00:00.000Z", moduleGroup: "host" },
    ];
    const { container } = render(<DataTable
      ariaLabel="Ereignisprotokoll"
      rows={rows}
      columns={[{ key: "summary", label: "Eintrag", render: (row) => row.id }]}
      timeZone="Europe/Berlin"
      emptyLabel="Keine Einträge"
    />);

    const labels = (): string[] => Array.from(container.querySelectorAll(".data-table__time"), (label) => label.textContent);
    expect(labels()).toEqual(["jetzt", "jetzt"]);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(labels()).toEqual(["jetzt", "jetzt"]);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(labels()).toEqual(["vor 1 Min.", "vor 1 Min."]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});
