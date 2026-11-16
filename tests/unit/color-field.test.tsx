import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ColorField } from "../../src/dashboard/ui/ColorField";

const TargetColorFields = (): ReactElement => {
  const [target, setTarget] = useState<"first" | "second">("first");
  const [values, setValues] = useState({ first: "#112233", second: "transparent" });
  const transparentFallback = target === "first" ? "#112233" : "#445566";
  return <>
    <button type="button" onClick={() => { setTarget("first"); }}>First target</button>
    <button type="button" onClick={() => { setTarget("second"); }}>Second target</button>
    <ColorField
      id="target-background"
      label="Background color"
      value={values[target]}
      unsetLabel="Unset"
      clearLabel="Clear"
      allowTransparent
      transparentLabel="Transparent"
      memoryScope={target}
      transparentFallbackColor={transparentFallback}
      onChange={(value) => { if (value !== undefined) setValues((current) => ({ ...current, [target]: value })); }}
    />
  </>;
};

describe("ColorField target memory", () => {
  afterEach(cleanup);

  it("restores the selected target's own solid color after switching targets", () => {
    render(<TargetColorFields />);
    fireEvent.click(screen.getByRole("button", { name: "First target" }));
    fireEvent.click(screen.getByRole("button", { name: "Second target" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Transparent" }));

    expect(screen.getByLabelText("Background color")).toHaveValue("#445566");
  });
});
