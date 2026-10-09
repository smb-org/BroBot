import {
  keepPreviousData,
  QueryCache,
  QueryClient,
  type QueryFunction,
} from "@tanstack/react-query";

import { PanelApiError, requestJson } from "../api";
import { isChannelQueryKey, type ChannelQueryParams } from "./keys";

const requestChannelResource: QueryFunction = ({ queryKey, signal }) => {
  if (!isChannelQueryKey(queryKey)) {
    throw new Error("Dashboard queries must use a channel-scoped query key.");
  }
  if (queryKey[2] === "module") {
    throw new Error("Module queries must provide their own query function.");
  }

  const [, channelId, resource, ...params] = queryKey;
  const resourcePath = resource.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const searchParams = new URLSearchParams();
  for (const queryParams of params) {
    const values = queryParams as ChannelQueryParams;
    for (const name of Object.keys(values).sort((a, b) => a.localeCompare(b))) {
      const value = values[name];
      if (value !== null && value !== undefined) searchParams.append(name, String(value));
    }
  }

  const search = searchParams.toString();
  const path = `/api/channels/${encodeURIComponent(channelId)}/${resourcePath}${search.length === 0 ? "" : `?${search}`}`;
  return requestJson<unknown>(path, { signal });
};

export const createDashboardQueryClient = (onAuthenticationRequired?: () => void): QueryClient =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof PanelApiError && error.status === 401) onAuthenticationRequired?.();
      },
    }),
    defaultOptions: {
      queries: {
        queryFn: requestChannelResource,
        staleTime: 30_000,
        gcTime: 600_000,
        placeholderData: keepPreviousData,
        retry: (failureCount, error) =>
          !(error instanceof PanelApiError && error.status === 401) && failureCount < 1,
      },
    },
  });
