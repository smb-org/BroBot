import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../../src/modules/contract";
import QuizOverlayEditor from "../../src/modules/quiz/overlay/editor";
import { DEFAULT_QUIZ_OVERLAY_CONFIG } from "../../src/modules/quiz/overlay/state";

describe("quiz overlay editor", () => {
  afterEach(cleanup);

  it("saves display preferences and keeps the correct-answer color option", () => {
    const onChange = vi.fn();
    render(<QuizOverlayEditor config={DEFAULT_QUIZ_OVERLAY_CONFIG as unknown as JsonObject} onChange={onChange} language="en" />);

    fireEvent.click(screen.getByRole("switch", { name: "Show percentages" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ showPercent: false }));

    fireEvent.change(screen.getByLabelText("Correct answer colour"), { target: { value: "#225588" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ correctColor: "#225588" }));
  });

  it("localizes controls and disables edits in read-only mode", () => {
    const onChange = vi.fn();
    render(<QuizOverlayEditor config={{}} onChange={onChange} language="de" readOnly readOnlyReason="Read only" />);

    const color = screen.getByLabelText("Farbe der richtigen Antwort");
    expect((color as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(color, { target: { value: "#225588" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
