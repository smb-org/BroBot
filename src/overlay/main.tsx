import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayStatusView } from "./status";

export { OverlayStatusView } from "./status";

const root = document.getElementById("root");
if (root === null) throw new Error("Overlay-Root fehlt.");

createRoot(root).render(
  <StrictMode>
    <OverlayStatusView />
  </StrictMode>,
);
