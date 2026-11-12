import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import GrantVipActionEditor from "../../src/modules/temp_vips/actions/grant-vip-editor";

afterEach(cleanup);

describe("grant VIP action editor", () => {
  it("shows the default duration with its unit and updates the action config", () => {
    const onChange = vi.fn();
    render(<UiProvider><GrantVipActionEditor config={{}} onChange={onChange} language="de" /></UiProvider>);

    const duration = screen.getByRole("spinbutton", { name: "Dauer" });
    expect(duration).toHaveValue(7);
    expect(duration.closest(".unit-input__control")).toHaveTextContent("Tage");

    fireEvent.change(duration, { target: { value: "14" } });
    expect(onChange).toHaveBeenCalledWith({ durationDays: 14 });
  });
});
