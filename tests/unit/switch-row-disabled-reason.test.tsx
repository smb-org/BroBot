import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SwitchRow } from "../../src/dashboard/ui";
import { DisabledFieldReasonContext } from "../../src/dashboard/ui/DisabledFieldReason";

describe("SwitchRow disabled-field reason", () => {
  afterEach(cleanup);

  it("describes a disabled switch with the surrounding reason", () => {
    render(<DisabledFieldReasonContext.Provider value={{ id: "ctx-reason", reason: "Read only." }}>
      <p id="ctx-reason">Read only.</p>
      <SwitchRow label="Show cover" checked disabled onChange={() => undefined} />
    </DisabledFieldReasonContext.Provider>);
    expect(screen.getByRole("switch", { name: "Show cover" })).toHaveAccessibleDescription("Read only.");
  });

  it("keeps an enabled switch free of the reason", () => {
    render(<DisabledFieldReasonContext.Provider value={{ id: "ctx-reason", reason: "Read only." }}>
      <p id="ctx-reason">Read only.</p>
      <SwitchRow label="Show cover" checked onChange={() => undefined} />
    </DisabledFieldReasonContext.Provider>);
    expect(screen.getByRole("switch", { name: "Show cover" })).not.toHaveAttribute("aria-describedby");
  });

  it("prefers an explicit lockedReason over the context reason", () => {
    render(<DisabledFieldReasonContext.Provider value={{ id: "ctx-reason", reason: "Read only." }}>
      <p id="ctx-reason">Read only.</p>
      <SwitchRow label="Show cover" checked disabled lockedReason="Needs input." onChange={() => undefined} />
    </DisabledFieldReasonContext.Provider>);
    const description = screen.getByRole("switch", { name: "Show cover" }).getAttribute("aria-describedby") ?? "";
    expect(description).not.toContain("ctx-reason");
    expect(screen.getByRole("switch", { name: "Show cover" })).toHaveAccessibleDescription("Needs input.");
  });
});
