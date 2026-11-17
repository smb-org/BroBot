import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayEditorPreviewBackground } from "../../src/dashboard/OverlayEditorPreviewBackground";
import { clickSelectOption } from "../query-test-utils";

const renderBackground = () => render(
  <OverlayEditorPreviewBackground language="en">
    {({ mode, imageUrl }) => <div data-testid="preview" data-mode={mode} data-image={imageUrl ?? ""} />}
  </OverlayEditorPreviewBackground>,
);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("overlay editor preview backgrounds", () => {
  it("starts transparent and remembers a selected background mode", async () => {
    const firstRender = renderBackground();
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "transparent"));
    const chooseOption = async (name: string): Promise<void> => {
      fireEvent.click(screen.getByRole("combobox", { name: "Preview background" }));
      clickSelectOption(await screen.findByRole("option", { name, hidden: true }));
    };
    await chooseOption("Light");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "light");
    await chooseOption("Dark");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "dark");
    await chooseOption("Own image");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "image");
    await chooseOption("Light");
    firstRender.unmount();

    renderBackground();
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "light"));
  });

  it("shows a selected image and removes it", async () => {
    const originalUrl = globalThis.URL;
    const createObjectURL = vi.fn(() => "preview-image");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...originalUrl, createObjectURL, revokeObjectURL });
    renderBackground();
    const file = new File(["preview"], "preview.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Choose preview image"), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "image"));
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-image", "preview-image"));
    fireEvent.click(screen.getByRole("button", { name: "Remove preview image" }));
    expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "transparent");
    expect(screen.getByTestId("preview")).toHaveAttribute("data-image", "");
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("preview-image"));
  });

  it("falls back to transparent when an image cannot be read from IndexedDB", async () => {
    const originalUrl = globalThis.URL;
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("URL", { ...originalUrl, createObjectURL: vi.fn(() => "temporary-preview-image"), revokeObjectURL: vi.fn() });
    const firstRender = renderBackground();
    fireEvent.change(screen.getByLabelText("Choose preview image"), {
      target: { files: [new File(["preview"], "preview.png", { type: "image/png" })] },
    });
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "image"));

    firstRender.unmount();
    renderBackground();

    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "transparent"));
  });
});
