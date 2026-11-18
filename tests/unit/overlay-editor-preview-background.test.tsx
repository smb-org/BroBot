import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayEditorPreviewBackground } from "../../src/dashboard/OverlayEditorPreviewBackground";
import { clickSelectOption } from "../query-test-utils";

const renderBackground = () => render(
  <OverlayEditorPreviewBackground language="en">
    {({ mode, imageUrl }) => <div data-testid="preview" data-mode={mode} data-image={imageUrl ?? ""} />}
  </OverlayEditorPreviewBackground>,
);

const createPreviewImageIndexedDb = (): { factory: IDBFactory; images: Map<string, Blob> } => {
  const images = new Map<string, Blob>();
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {};
      return Object.assign(transaction, {
        objectStore: () => ({
          get: (key: string) => {
            const request: { result: Blob | undefined; onsuccess?: () => void } = { result: images.get(key) };
            queueMicrotask(() => {
              request.onsuccess?.();
              queueMicrotask(() => transaction.oncomplete?.());
            });
            return request;
          },
          put: (image: Blob, key: string) => {
            images.set(key, image);
            queueMicrotask(() => transaction.oncomplete?.());
            return {};
          },
          delete: (key: string) => {
            images.delete(key);
            queueMicrotask(() => transaction.oncomplete?.());
            return {};
          },
        }),
      }) as unknown as IDBTransaction;
    },
    close: () => undefined,
  } as unknown as IDBDatabase;
  const factory = {
    open: () => {
      const request: { result: IDBDatabase; onsuccess?: () => void } = { result: database };
      queueMicrotask(() => request.onsuccess?.());
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return { factory, images };
};

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

  it("restores an uploaded image after switching to Light and reloading", async () => {
    const indexedDb = createPreviewImageIndexedDb();
    vi.stubGlobal("indexedDB", indexedDb.factory);
    const originalUrl = globalThis.URL;
    let nextObjectUrl = 0;
    const createObjectURL = vi.fn(() => `preview-image-${String(++nextObjectUrl)}`);
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...originalUrl, createObjectURL, revokeObjectURL });
    const chooseOption = async (name: string): Promise<void> => {
      fireEvent.click(screen.getByRole("combobox", { name: "Preview background" }));
      clickSelectOption(await screen.findByRole("option", { name, hidden: true }));
    };

    const firstView = renderBackground();
    const file = new File(["preview"], "preview.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Choose preview image"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-image", "preview-image-1"));
    await waitFor(() => expect(indexedDb.images.get("custom")).toBe(file));
    await chooseOption("Light");
    firstView.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("preview-image-1");

    const secondView = renderBackground();
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "light"));
    await chooseOption("Own image");
    await waitFor(() => expect(screen.getByTestId("preview")).toHaveAttribute("data-image", "preview-image-2"));
    secondView.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("preview-image-2");
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
