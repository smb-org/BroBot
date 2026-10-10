import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

import { DashboardDataProvider } from "../../src/dashboard/data/provider";
import { UiProvider } from "../../src/dashboard/ui";
import { useRealtimePanelMessages } from "../../src/dashboard/realtime";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import ApiSourcePanel from "../../src/modules/api_source/panel";
import BelaboxPanel from "../../src/modules/belabox/panel";
import BelaboxStatusAction from "../../src/modules/belabox/panel/immediate-actions";
import ChatVotingImmediateAction from "../../src/modules/chat_voting/panel/immediate-actions";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import FaqPanel from "../../src/modules/faq/panel";
import { TextCommandsPanel } from "../../src/modules/text_commands/panel";
import TextLibraryPanel from "../../src/modules/text_library/panel";
import TimersPanel from "../../src/modules/timers/panel";
import VotekickPanel from "../../src/modules/votekick/panel";
import "../../src/dashboard/styles.css";

const channelId = "channel-a";
const query = new URLSearchParams(window.location.search);
const language = query.get("lang") === "de" ? "de" : "en";
const panelName = query.get("panel");
const realtimeEnabled = query.get("realtime") === "1";

export const RealtimeHarness = ({ children }: { children: ReactNode }) => {
  useRealtimePanelMessages(realtimeEnabled ? channelId : null, realtimeEnabled);
  return <>{children}</>;
};

const panel = panelName === "api_source" ? <ApiSourcePanel channelId={channelId} language={language} canManage />
  : panelName === "belabox" ? <BelaboxPanel channelId={channelId} language={language} canManage />
  : panelName === "belabox-action" ? <BelaboxStatusAction channelId={channelId} canManage availabilityReason={null} />
    : panelName === "chat_voting" ? <ChatVotingPanel channelId={channelId} language={language} canOperate />
      : panelName === "chat_voting-action" ? <ChatVotingImmediateAction channelId={channelId} canManage availabilityReason={null} />
      : panelName === "faq" ? <FaqPanel channelId={channelId} language={language} />
        : panelName === "text_commands" ? <TextCommandsPanel channelId={channelId} language={language} />
          : panelName === "text_library" ? <TextLibraryPanel channelId={channelId} language={language} canManage />
          : panelName === "timers" ? <TimersPanel channelId={channelId} language={language} />
            : panelName === "votekick" ? <VotekickPanel channelId={channelId} language={language} />
              : <p>Choose a module panel.</p>;

createRoot(document.getElementById("root") as HTMLElement).render(
  <DashboardDataProvider>
    <RealtimeHarness>
      <UiProvider>
        <main className="main-content" style={{ width: "min(1400px, 100%)", padding: "16px" }}>
          {panel}
          {panelName === "chat_voting" ? <button type="button" onClick={() => {
            runDashboardNavigationGuards(() => { window.location.assign("/tests/e2e/module-panels-stability-fixture.html?panel=api_source"); }, () => undefined);
          }}>Leave panel</button> : null}
        </main>
      </UiProvider>
    </RealtimeHarness>
  </DashboardDataProvider>,
);
