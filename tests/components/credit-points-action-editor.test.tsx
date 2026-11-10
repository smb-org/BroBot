import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import CreditPointsActionEditor from "../../src/modules/points/actions/credit-points-editor";

afterEach(cleanup);

describe("credit points action editor", () => {
  it("shows the amount with its unit and updates the action config", () => {
    const onChange = vi.fn();
    render(<UiProvider><CreditPointsActionEditor
      config={{ amount: 125 }}
      onChange={onChange}
      language="de"
    /></UiProvider>);

    const amount = screen.getByRole("spinbutton", { name: "Punkte" });
    expect(amount).toHaveValue(125);
    expect(amount.closest(".unit-input__control")).toHaveTextContent("Punkte");

    fireEvent.change(amount, { target: { value: "240" } });
    expect(onChange).toHaveBeenCalledWith({ amount: 240 });
  });
});
