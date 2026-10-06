import { createRoot } from "react-dom/client";

import { UiProvider } from "../../src/dashboard/ui";
import ApiSourcePanel from "../../src/modules/api_source/panel";
import BelaboxPanel from "../../src/modules/belabox/panel";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import FaqPanel from "../../src/modules/faq/panel";
import { TextCommandsPanel } from "../../src/modules/text_commands/panel";
import TimersPanel from "../../src/modules/timers/panel";
import VotekickPanel from "../../src/modules/votekick/panel";
import "../../src/dashboard/styles.css";

const channelId = "channel-a";
const language = "en";
const panelName = new URLSearchParams(window.location.search).get("panel");

const panel = panelName === "api_source" ? <ApiSourcePanel channelId={channelId} language={language} canManage />
  : panelName === "belabox" ? <BelaboxPanel channelId={channelId} language={language} canManage />
    : panelName === "chat_voting" ? <ChatVotingPanel channelId={channelId} language={language} canOperate />
      : panelName === "faq" ? <FaqPanel channelId={channelId} language={language} />
        : panelName === "text_commands" ? <TextCommandsPanel channelId={channelId} language={language} />
          : panelName === "timers" ? <TimersPanel channelId={channelId} language={language} />
            : panelName === "votekick" ? <VotekickPanel channelId={channelId} language={language} />
              : <p>Choose a module panel.</p>;

createRoot(document.getElementById("root") as HTMLElement).render(
  <UiProvider>
    <main className="main-content" style={{ width: "min(960px, 100%)", padding: "16px" }}>
      {panel}
    </main>
  </UiProvider>,
);
