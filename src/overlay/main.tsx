import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayEntry } from "./status";

export { OverlayEntry, OverlayStatusView } from "./status";

const root = document.getElementById("root");
if (root === null) throw new Error("Overlay root is missing.");

createRoot(root).render(
  <StrictMode>
    <OverlayEntry />
  </StrictMode>,
);
