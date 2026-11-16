import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ModuleOverlayElementEditor } from "../../src/dashboard/ModuleOverlayElementEditor";
import { OverlayAppearanceEditor } from "../../src/dashboard/OverlayAppearanceEditor";
import type { JsonObject } from "../../src/modules/contract";
import { emoteSlotOverlayElement } from "../../src/modules/emote_slots/overlay/element";
import { overlayAlertElement } from "../../src/modules/overlay_alerts/overlay/element";

afterEach(cleanup);

describe("shared overlay appearance editor", () => {
  it("uses the same ordered fields, reports contrast, and supports transparency", () => {
    const onChange = vi.fn();
    const definition = emoteSlotOverlayElement.appearance;
    const { container, rerender } = render(<OverlayAppearanceEditor
      definition={definition}
      value={emoteSlotOverlayElement.defaultConfig.appearance}
      language="en"
      onChange={onChange}
    />);

    const section = screen.getByRole("group", { name: "Appearance" });
    expect(within(section).getAllByText(/background color|text color|secondary text color|accent color/i).map((node) => node.textContent)).toEqual([
      "Background color",
      "Text color",
      "Secondary text color",
      "Accent color",
    ]);
    expect(within(section).getByRole("status")).toHaveAttribute("data-status", "ok");

    fireEvent.click(within(section).getByRole("checkbox", { name: "Transparent background" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ background: "transparent" }));
    expect(container.querySelector("input[type='color']")).toBeInTheDocument();

    rerender(<OverlayAppearanceEditor
      definition={definition}
      value={{ background: "#ffffff", text: "#ffffff", secondaryText: "#000000", accent: "#000000" }}
      language="en"
      onChange={onChange}
    />);
    expect(within(screen.getByRole("group", { name: "Appearance" })).getByRole("status")).toHaveAttribute("data-status", "warning");
  });

  it("restores the original alpha color after toggling a background transparent", () => {
    const onChange = vi.fn();
    const appearance = { background: "rgb(16 20 27 / 84%)", text: "#ffffff" };
    const { rerender } = render(<OverlayAppearanceEditor
      definition={overlayAlertElement.appearance}
      value={appearance}
      language="en"
      onChange={onChange}
    />);

    fireEvent.click(screen.getByRole("checkbox", { name: "Transparent background" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ background: "transparent" }));

    rerender(<OverlayAppearanceEditor
      definition={overlayAlertElement.appearance}
      value={{ ...appearance, background: "transparent" }}
      language="en"
      onChange={onChange}
    />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Transparent background" }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ background: appearance.background }));
  });

  it("keeps the old alert options and text colour when the shared block is edited", () => {
    const parsed = overlayAlertElement.parseConfig({ textColor: "#abcdef", fontSize: 56 });
    if (parsed === null) throw new Error("The old alert config should remain valid.");
    const onChange = vi.fn<(config: JsonObject) => void>();
    render(<ModuleOverlayElementEditor
      kind={overlayAlertElement.kind}
      config={parsed}
      channelId="channel-demo"
      language="en"
      onChange={onChange}
    />);

    fireEvent.change(screen.getByLabelText("Background color"), { target: { value: "#010203" } });

    expect(onChange).toHaveBeenLastCalledWith({
      fontSize: 56,
      appearance: { background: "#010203", text: "#abcdef" },
    });
  });

  it("renders the shared block for an element without its own editor and preserves old element options", () => {
    const oldConfig = {
      backgroundColor: "#112233",
      textColor: "#223344",
      secondaryColor: "#334455",
      highlightColor: "#445566",
      borderColor: "#556677",
    };
    const parsed = emoteSlotOverlayElement.parseConfig(oldConfig);
    if (parsed === null) throw new Error("The old slot config should remain valid.");
    const onChange = vi.fn<(config: JsonObject) => void>();
    render(<ModuleOverlayElementEditor
      kind={emoteSlotOverlayElement.kind}
      config={parsed}
      channelId="channel-demo"
      language="en"
      onChange={onChange}
    />);

    expect(screen.getByRole("group", { name: "Appearance" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Accent color"), { target: { value: "#abcdef" } });

    expect(onChange).toHaveBeenLastCalledWith({
      borderColor: "#556677",
      appearance: {
        background: "#112233",
        text: "#223344",
        secondaryText: "#334455",
        accent: "#abcdef",
      },
    });
  });
});
