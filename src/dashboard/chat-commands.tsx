import type { ReactElement } from "react";

import type { ModuleChatCommandDeclaration } from "../modules/contract";
import { dashboardLanguage, dashboardTexts, type DashboardLanguage } from "./locale";

export const ChatCommands = ({ commands, language = dashboardLanguage() }: {
  commands: readonly ModuleChatCommandDeclaration[];
  language?: DashboardLanguage;
}): ReactElement | null => {
  if (commands.length === 0) return null;

  const texts = dashboardTexts(language).module;
  return (
    <section className="content-section module-chat-commands" aria-labelledby="module-chat-commands-heading">
      <div className="section-heading">
        <h2 id="module-chat-commands-heading">{texts.chatCommands}</h2>
      </div>
      <ul className="module-chat-commands__list">
        {commands.map((command) => (
          <li className="module-chat-command" key={command.name}>
            <code className="number">{command.syntax}</code>
            <p className="module-chat-command__description">{command.description[language]}</p>
            {command.arguments === undefined || command.arguments.length === 0 ? null : (
              <div className="module-chat-command__arguments">
                <h3>{texts.chatCommandArguments}</h3>
                <dl>
                  {command.arguments.map((argument) => (
                    <div key={argument.name}>
                      <dt><code className="number">{argument.name}</code></dt>
                      <dd>{argument.hint[language]}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
            <p className="module-chat-command__threshold">
              <span>{texts.chatCommandAvailableTo}:</span> {texts.chatCommandThresholds[command.minimumChatStatus]}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
};
