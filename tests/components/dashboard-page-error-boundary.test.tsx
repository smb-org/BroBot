import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { DashboardPageErrorBoundary } from "../../src/dashboard/DashboardPageErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps the dashboard shell visible when route content throws", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const BrokenPage = (): ReactElement => { throw new Error("Unexpected render failure"); };

  render(
    <>
      <header>Dashboard header</header>
      <DashboardPageErrorBoundary fallback={<p role="alert">Page could not load.</p>}>
        <BrokenPage />
      </DashboardPageErrorBoundary>
    </>,
  );

  expect(screen.getByRole("banner")).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent("Page could not load.");
});
