import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

import { createDashboardQueryClient } from "../src/dashboard/data/client";
import { dispatchDashboardAuthenticationRequired } from "../src/dashboard/data/events";

export interface DashboardQueryTestOptions {
  gcTime?: number;
  staleTime?: number;
}

export const renderWithQuery = (
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
  queryOptions: DashboardQueryTestOptions = {},
) => {
  const queryClient = createDashboardQueryClient(dispatchDashboardAuthenticationRequired);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: {
      ...queryClient.getDefaultOptions().queries,
      retry: false,
      gcTime: queryOptions.gcTime ?? 0,
      ...(queryOptions.staleTime === undefined ? {} : { staleTime: queryOptions.staleTime }),
    },
  });

  return {
    ...render(ui, {
      ...options,
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    }),
    queryClient,
  };
};
