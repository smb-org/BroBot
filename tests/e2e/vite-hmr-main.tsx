import { createRoot } from "react-dom/client";

import { Counter } from "./vite-hmr-counter";

const mount = document.getElementById("root");
if (mount === null) throw new Error("Missing Fast Refresh test mount.");

createRoot(mount).render(<Counter />);
