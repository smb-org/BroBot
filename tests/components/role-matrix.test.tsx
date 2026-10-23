import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ROLE_MATRIX_ACTIONS } from "../../src/contracts/values";
import { RoleMatrixDisclosure } from "../../src/dashboard/role-matrix";
import { UiProvider } from "../../src/dashboard/ui";

afterEach(() => { cleanup(); });

describe("RoleMatrixDisclosure", () => {
  it("is collapsed by default and opens its matrix inside its own scroll area", () => {
    const { container } = render(<UiProvider><RoleMatrixDisclosure /></UiProvider>);

    const disclosure = screen.getByRole("group", { name: /berechtigungen|permissions/iu });
    const summary = within(disclosure).getByText(/berechtigungen ansehen|view permissions/iu);
    const details = disclosure.querySelector("details");
    expect(details?.open).toBe(false);

    fireEvent.click(summary);

    const matrix = within(disclosure).getByRole("table");
    expect(details?.open).toBe(true);
    expect(matrix.querySelectorAll("tbody tr")).toHaveLength(ROLE_MATRIX_ACTIONS.length);
    expect(disclosure.querySelector(".role-matrix__scroll")).toBeInTheDocument();
    expect(container.querySelector(".role-matrix__scroll")?.getAttribute("tabindex")).toBe("0");
  });
});
