import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

export const OverlayPlaceholder = (): ReactElement => (
  <main>
    <h1>BroBot Overlay</h1>
    <p>Das transparente Overlay-Gerüst ist bereit für spätere Module.</p>
  </main>
);

const root = document.getElementById("root");
if (root === null) throw new Error("Overlay-Root fehlt.");

createRoot(root).render(
  <StrictMode>
    <OverlayPlaceholder />
  </StrictMode>,
);
