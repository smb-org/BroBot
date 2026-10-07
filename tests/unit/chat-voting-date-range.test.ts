import { describe, expect, it } from "vitest";

import { compactDateRange } from "../../src/modules/chat_voting/panel/date-range";

const local = (day: number, hour: number, minute: number): string => new Date(2030, 9, day, hour, minute).toISOString();

describe("compactDateRange", () => {
  it("shows times only within one day", () => {
    const [from, to] = compactDateRange(local(6, 20, 0), local(6, 20, 5), "en", "(+1)");
    expect(from).toMatch(/8:00/);
    expect(to).toMatch(/8:05/);
    expect(`${from}${to}`).not.toMatch(/10|\//);
  });

  it("shows the date once and marks the end as next day for overnight votes", () => {
    const [from, to] = compactDateRange(local(6, 23, 50), local(7, 0, 10), "de", "(+1)");
    expect(from).toContain("06.10.");
    expect(from).toContain("23:50");
    expect(to).toBe("00:10 (+1)");
  });

  it("repeats both dates beyond one day", () => {
    const [from, to] = compactDateRange(local(6, 23, 50), local(8, 0, 10), "en", "(+1)");
    expect(from).toContain("10/6");
    expect(to).toContain("10/8");
    expect(to).not.toContain("(+1)");
  });

  it("returns placeholders for invalid input", () => {
    expect(compactDateRange("x", "y", "en", "(+1)")).toEqual(["—", "—"]);
  });
});
