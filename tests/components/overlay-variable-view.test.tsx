import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VariableValueView } from "../../src/overlay/variable-view";

describe("VariableValueView", () => {
  it("renders a namespaced channel variable token as the value placeholder", () => {
    const { container } = render(<VariableValueView name="score" text="Score: {var.score}" value={1234} language="en" />);

    expect(container.querySelector(".brobot-variable__text")).toHaveTextContent(/^Score:$/);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1,234");
  });

  it("keeps {value} as an alias for the selected channel variable", () => {
    const { container } = render(<VariableValueView name="score" text="Score: {value}" value={1234} language="en" />);

    expect(container.querySelector(".brobot-variable__text")).toHaveTextContent(/^Score:$/);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1,234");
  });

  it("keeps an inherited object property token literal when no channel variable exists", () => {
    const { container } = render(<VariableValueView name="score" text="{var.constructor}" value={42} language="en" />);

    expect(container.querySelector(".brobot-variable")?.textContent).toBe("{var.constructor} 42");
  });
});
