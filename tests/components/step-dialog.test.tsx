import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StepDialog } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("StepDialog", () => {
  it("keeps its declared height when the active step content changes", () => {
    const props = { opened: true, title: "Setup", onClose: () => undefined };
    const view = render(<StepDialog {...props}><p>First step</p></StepDialog>);
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    const height = "min(760px, calc(100dvh - 32px))";

    expect(dialog).toHaveStyle({ height });
    view.rerender(<StepDialog {...props}><p>Second step with longer content.</p></StepDialog>);

    expect(screen.getByRole("dialog", { name: "Setup" })).toHaveStyle({ height });
  });
});
