import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

import { createDashboardQueryClient } from "../src/dashboard/data/client";
import { dispatchDashboardAuthenticationRequired } from "../src/dashboard/data/events";

export interface DashboardQueryTestOptions {
  gcTime?: number;
  staleTime?: number;
  initialData?: readonly { queryKey: readonly unknown[]; data: unknown }[];
  /** Reuse an existing client, e.g. to remount a page against a warm cache. */
  queryClient?: QueryClient;
  /** Revision vector returned to the connected panel socket in this render. */
  panelRevisions?: Readonly<Record<string, number>> | null;
}

export const renderWithQuery = (
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">,
  queryOptions: DashboardQueryTestOptions = {},
) => {
  if (queryOptions.panelRevisions !== undefined && queryOptions.panelRevisions !== null) {
    const previousFetch = globalThis.fetch;
    const revisions = queryOptions.panelRevisions;
    const revisionFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request
        ? new URL(input.url)
        : input instanceof URL ? input : new URL(input, window.location.href);
      if (/^\/api\/channels\/[^/]+\/revisions$/u.test(url.pathname)) {
        return Promise.resolve(new Response(JSON.stringify({ revisions }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return previousFetch(input, init);
    });
    vi.stubGlobal("fetch", revisionFetch);
  }
  const queryClient = queryOptions.queryClient ?? createDashboardQueryClient(dispatchDashboardAuthenticationRequired);
  queryClient.setDefaultOptions({
    ...queryClient.getDefaultOptions(),
    queries: {
      ...queryClient.getDefaultOptions().queries,
      retry: false,
      gcTime: queryOptions.gcTime ?? 0,
      ...(queryOptions.staleTime === undefined ? {} : { staleTime: queryOptions.staleTime }),
    },
  });
  for (const entry of queryOptions.initialData ?? []) {
    queryClient.setQueryData(entry.queryKey, entry.data);
  }

  return {
    ...render(ui, {
      ...options,
      wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    }),
    queryClient,
  };
};
