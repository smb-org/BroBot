import { createRoot } from "react-dom/client";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { UiProvider } from "../../src/dashboard/ui";
import BlitzRoundPanel from "../../src/modules/blitz_round/panel";
import "../../src/dashboard/ui/core.css";

const query = new URLSearchParams(window.location.search);
const language = query.get("lang") === "de" ? "de" : "en";
const cockpit = query.get("cockpit") === "1";
const moduleEnabled = query.get("enabled") !== "0";
const root = document.getElementById("root");

if (root === null) throw new Error("Fixture root is missing.");

createRoot(root).render(
  <DashboardDataProvider>
    <UiProvider>
      <main className="main-content" style={{ boxSizing: "border-box", display: "flex", flexDirection: "column", width: "min(1680px, 100%)", height: "100dvh", minHeight: 0, padding: "20px 24px" }}>
        {cockpit
          ? <ImmediateActions channelId="fictional_channel" streamState="online" role="broadcaster" modules={[{ id: "blitz_round", enabled: moduleEnabled }]} />
          : <BlitzRoundPanel channelId="fictional_channel" language={language} />}
      </main>
    </UiProvider>
  </DashboardDataProvider>,
);
