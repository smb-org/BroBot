import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Suspense, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RetryableLazy } from "../../src/dashboard/RetryableLazy";

afterEach(() => {
  cleanup();
});

describe("RetryableLazy", () => {
  it("creates a new lazy instance and retries a failed import", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ default: () => <p>Panel loaded</p> });

    render(<RetryableLazy
      instanceKey="panel:test"
      load={load}
      properties={{}}
      loadingFallback={<p>Loading panel</p>}
      renderError={(retry) => <div role="alert"><p>Panel failed</p><button type="button" onClick={retry}>Retry</button></div>}
    />);

    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Panel loaded")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps the lazy type stable when its first render suspends to the route boundary", async () => {
    let resolveLoad: ((module: { default: () => ReactElement }) => void) | undefined;
    const pendingLoad = new Promise<{ default: () => ReactElement }>((resolve) => { resolveLoad = resolve; });
    const load = vi.fn(() => pendingLoad);

    render(
      <Suspense fallback={<p>Route pending</p>}>
        <RetryableLazy
          instanceKey="panel:route-boundary"
          load={load}
          properties={{}}
          loadingFallback={<p>Panel pending</p>}
          renderError={() => <p>Panel failed</p>}
          suspendToParent
        />
      </Suspense>,
    );

    expect(screen.getByText("Route pending")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveLoad?.({ default: () => <p>Panel ready</p> });
      await pendingLoad;
    });

    expect(await screen.findByText("Panel ready")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
