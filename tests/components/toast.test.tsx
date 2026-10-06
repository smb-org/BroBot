import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider, notify } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";

describe("dashboard toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    render(<UiProvider><ToastHost /></UiProvider>);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps errors until dismissed and announces them assertively", () => {
    act(() => { notify({ tone: "error", message: "The update failed." }); });
    const toast = screen.getByRole("alert");
    expect(toast).toHaveTextContent("The update failed.");
    expect(toast).toHaveAttribute("aria-live", "assertive");

    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    act(() => { screen.getByRole("button", { name: /schließen|close/iu }).click(); });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("auto-dismisses success and info politely", () => {
    act(() => {
      notify({ tone: "success", message: "Saved." });
      notify({ tone: "info", message: "A refresh is available." });
    });
    expect(screen.getByText("Saved.").closest("[role='status']")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByText("A refresh is available.").closest("[role='status']")).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByText("Saved.")).not.toBeInTheDocument();
    expect(screen.queryByText("A refresh is available.")).not.toBeInTheDocument();
  });
});
