import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmDialog, Field, Select, UiProvider } from "../../src/dashboard/ui";

afterEach(cleanup);

describe("clipped text disclosures", () => {
  it("reveals long hints and errors in portal popovers with keyboard-operable controls", async () => {
    const hint = "A long hint with the details needed to configure this field correctly.";
    const fieldError = "The field value is too long and must be shortened before saving.";
    const dialogError = "The update failed because another change conflicts with this request.";
    const { container } = render(<UiProvider>
      <Field label="Name" hint={hint} value="hello" error={fieldError} onChange={() => {}} />
      <ConfirmDialog opened title="Confirm" description="Continue?" confirmLabel="Confirm" cancelLabel="Cancel" onConfirm={() => {}} onCancel={() => {}} error={dialogError} />
    </UiProvider>);

    const hintButton = container.querySelector(".ui-field__hint .ui-text-reveal__trigger") as HTMLButtonElement;
    expect(hintButton.tabIndex).toBe(0);
    hintButton.focus();
    fireEvent.click(hintButton);
    expect(hintButton).toHaveAttribute("aria-expanded", "true");
    const hintPopup = await screen.findByRole("tooltip");
    expect(hintPopup).toHaveTextContent(hint);
    expect(hintPopup.closest(".ui-field")).toBeNull();
    fireEvent.click(hintButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const fieldErrorButton = container.querySelector(".ui-field .mantine-InputWrapper-error .ui-text-reveal__trigger") as HTMLButtonElement;
    fireEvent.click(fieldErrorButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(fieldError);
    fireEvent.click(fieldErrorButton);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());

    const dialog = screen.getByRole("dialog", { name: "Confirm" });
    const dialogErrorButton = within(dialog).getByRole("button", { name: /show full text|vollständigen text anzeigen/iu });
    fireEvent.click(dialogErrorButton);
    const dialogErrorPopup = await screen.findByRole("tooltip");
    expect(dialogErrorPopup).toHaveTextContent(dialogError);
    expect(dialogErrorPopup.closest(".mantine-Modal-content")).toBeNull();
  });

  it("omits reserved description and error rows only in compact Select mode", () => {
    const { container } = render(<UiProvider><div>
      <Select id="header-channel" compact ariaLabel="Channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="Header hint" error="Header error" />
      <Select id="form-channel" label="Channel" value="one" onChange={() => {}} options={[{ value: "one", label: "One" }]} hint="Form hint" error="Form error" />
    </div></UiProvider>);

    const compact = container.querySelector("#header-channel")?.closest(".ui-select");
    expect(compact).toHaveClass("ui-select--compact");
    expect(compact?.querySelector(".mantine-InputWrapper-description")).not.toBeInTheDocument();
    expect(compact?.querySelector(".mantine-InputWrapper-error")).not.toBeInTheDocument();
    expect(container.querySelector("#form-channel")?.closest(".ui-select")).toHaveTextContent("Form hint");
    expect(container.querySelector("#form-channel")?.closest(".ui-select")).toHaveTextContent("Form error");
  });
});
