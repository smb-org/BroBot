import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ColorField } from "../../src/dashboard/ui/ColorField";

describe("ColorField", () => {
  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--content-default");
    document.documentElement.style.removeProperty("--color-on-error");
  });

  it("keeps the unset swatch on the content default when error contrast changes", () => {
    document.documentElement.style.setProperty("--content-default", "#ffffff");
    document.documentElement.style.setProperty("--color-on-error", "#000000");

    render(<ColorField id="accent-color" label="Accent color" value={undefined} unsetLabel="Not set" clearLabel="Clear color" onChange={vi.fn()} />);

    expect(screen.getByLabelText("Accent color")).toHaveValue("#ffffff");
  });

  it("describes an unset disabled color and dims its full swatch control", () => {
    render(<ColorField id="accent-color" label="Accent color" value={undefined} unsetLabel="Not set" clearLabel="Clear color" disabled onChange={vi.fn()} />);

    const input = screen.getByLabelText("Accent color");
    expect(input).toHaveAccessibleDescription("Not set");
    expect(input).toBeDisabled();
    expect(input.parentElement).toHaveAttribute("data-disabled", "true");
  });
});
