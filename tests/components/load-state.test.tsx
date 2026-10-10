import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoadState, UiProvider } from "../../src/dashboard/ui";

describe("LoadState retry layout", () => {
  afterEach(() => {
    cleanup();
  });

  it("reserves the same content and retry rows before and after an error", () => {
    const minHeight = "calc(var(--s10) * 5)";
    const queryError = { title: "Data could not be loaded.", message: "Unable to load.", onRetry: vi.fn() };
    const { container, rerender } = render(
      <UiProvider>
        <LoadState
          status="success"
          minHeight={minHeight}
          loading={<div />}
          empty={<div />}
          error={<p role="alert">Unable to load.</p>}
          queryError={queryError}
          refreshError={false}
        >
          <div>Loaded content</div>
        </LoadState>
      </UiProvider>,
    );

    const root = container.querySelector<HTMLElement>(".ui-load-state");
    const content = container.querySelector<HTMLElement>(".ui-load-state__content");
    expect(root?.style.minHeight).toBe("calc(var(--ui-load-state-content-min-height) + var(--s10))");
    expect(root?.style.getPropertyValue("--ui-load-state-content-min-height")).toBe(minHeight);
    expect(content?.style.minHeight).toBe(minHeight);
    expect(screen.queryByRole("button", { name: /^(Retry|Erneut versuchen)$/u })).not.toBeInTheDocument();
    expect(container.querySelector(".ui-load-state__retry-slot")).toBeInTheDocument();

    rerender(
      <UiProvider>
        <LoadState
          status="success"
          minHeight={minHeight}
          loading={<div />}
          empty={<div />}
          error={<p role="alert">Unable to load.</p>}
          queryError={queryError}
          refreshError={true}
        >
          <div>Loaded content</div>
        </LoadState>
      </UiProvider>,
    );

    expect(root?.style.minHeight).toBe("calc(var(--ui-load-state-content-min-height) + var(--s10))");
    expect(content?.style.minHeight).toBe(minHeight);
    expect(container.querySelector(".query-error-state__message")).toHaveTextContent("Unable to load.");
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));
    expect(queryError.onRetry).toHaveBeenCalledOnce();

    rerender(
      <UiProvider>
        <LoadState
          status="error"
          minHeight={minHeight}
          loading={<div />}
          empty={<div />}
          error={<p role="alert">Unable to load.</p>}
          queryError={queryError}
          refreshError={false}
        >
          <div>Loaded content</div>
        </LoadState>
      </UiProvider>,
    );

    expect(root?.style.minHeight).toBe("calc(var(--ui-load-state-content-min-height) + var(--s10))");
    expect(root?.style.getPropertyValue("--ui-load-state-content-min-height")).toBe(minHeight);
    expect(content?.style.minHeight).toBe(minHeight);
    expect(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u })).toBeVisible();
    expect(screen.getByText("Data could not be loaded.")).toBeVisible();
  });
});
