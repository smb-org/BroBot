import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
