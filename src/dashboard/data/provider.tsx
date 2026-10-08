import { useState, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";

import { createDashboardQueryClient } from "./client";

export interface DashboardDataProviderProps {
  children: ReactNode;
  onAuthenticationRequired?: () => void;
}

export function DashboardDataProvider({ children, onAuthenticationRequired }: DashboardDataProviderProps) {
  const [queryClient] = useState(() => createDashboardQueryClient(onAuthenticationRequired));

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
