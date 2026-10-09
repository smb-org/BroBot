import { QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";

import { createDashboardQueryClient } from "../src/dashboard/data/client";
import { dispatchDashboardAuthenticationRequired } from "../src/dashboard/data/events";

export const renderWithQuery = (ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) => {
  const queryClient = createDashboardQueryClient(dispatchDashboardAuthenticationRequired);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: {
      ...queryClient.getDefaultOptions().queries,
      retry: false,
      gcTime: 0,
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
