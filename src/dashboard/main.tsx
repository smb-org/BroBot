import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

export const DashboardPlaceholder = (): ReactElement => (
  <main>
    <h1>BroBot Dashboard</h1>
    <p>Das Dashboard-Gerüst ist bereit für die späteren Feature-Slices.</p>
  </main>
);

const root = document.getElementById("root");
if (root === null) throw new Error("Dashboard-Root fehlt.");

createRoot(root).render(
  <StrictMode>
    <DashboardPlaceholder />
  </StrictMode>,
);
