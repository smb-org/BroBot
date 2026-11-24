import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DiscordLinkPage } from "./public-page";

const root = document.getElementById("root");
if (root !== null) createRoot(root).render(<StrictMode><DiscordLinkPage /></StrictMode>);
