import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoadState, UiProvider } from "../../src/dashboard/ui";

describe("LoadState retry layout", () => {
  afterEach(() => {
    cleanup();
  });

  it("reserves the same content and retry rows before and after an error", () => {
    const minHeight = "200px";
    const queryError = { title: "Data could not be loaded.", message: "Unable to load.", onRetry: vi.fn() };
    const { container, rerender } = render(
      <UiProvider>
        <LoadState
          variant="panel-200"
          status="success"
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
          variant="panel-200"
          status="success"
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
    expect(container.querySelector(".ui-load-state__inline-message")).toHaveTextContent("Unable to load.");
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));
    expect(queryError.onRetry).toHaveBeenCalledOnce();

    rerender(
      <UiProvider>
        <LoadState
          variant="panel-200"
          status="error"
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

  it("keeps initial errors compact inside a fixed reservation", () => {
    const minHeight = "calc(var(--s6) + var(--s10))";
    const queryError = { message: "Template variables could not be loaded.", onRetry: vi.fn() };
    const { container, rerender } = render(
      <UiProvider>
        <LoadState
          variant="compact-64"
          status="loading"
          loading={<div />}
          empty={<div />}
          error={<div />}
          queryError={queryError}
        >{null}</LoadState>
      </UiProvider>,
    );

    const root = container.querySelector<HTMLElement>(".ui-load-state");
    expect(root?.style.minHeight).toBe(minHeight);
    expect(root?.querySelector(".ui-load-state__content")).toBeInTheDocument();

    rerender(
      <UiProvider>
        <LoadState
          variant="compact-64"
          status="error"
          loading={<div />}
          empty={<div />}
          error={<div />}
          queryError={queryError}
        >{null}</LoadState>
      </UiProvider>,
    );

    expect(root?.style.minHeight).toBe(minHeight);
    expect(root?.querySelector(".ui-load-state__inline-error")).toBeInTheDocument();
    expect(root?.querySelector(".ui-error-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));
    expect(queryError.onRetry).toHaveBeenCalledOnce();

    rerender(
      <UiProvider>
        <LoadState
          variant="compact-64"
          status="success"
          loading={<div />}
          empty={<div />}
          error={<div />}
          queryError={queryError}
        >{null}</LoadState>
      </UiProvider>,
    );
    expect(root?.style.minHeight).toBe(minHeight);
  });
});
