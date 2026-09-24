import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OverlayApp } from "./app";

const root = document.getElementById("root");
if (root === null) throw new Error("Overlay root is missing.");

const debugRequested = (): boolean => {
  const fragment = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  return new URLSearchParams(fragment).get("debug") === "1";
};

createRoot(root, {
  onCaughtError: (error, errorInfo) => {
    if (debugRequested()) console.error("An overlay element failed to render.", error, errorInfo.componentStack);
  },
}).render(
  <StrictMode>
    <OverlayApp />
  </StrictMode>,
);
