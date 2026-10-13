import { useState, type ReactElement } from "react";

import type { ModuleChatCommandDeclaration } from "../modules/contract";
import { dashboardLanguage, dashboardTexts, formatNumber, type DashboardLanguage } from "./locale";
import { notify } from "./ui/toast-store";
import { Button } from "./ui/Button";
import { PopoverContent, PopoverPrimitive } from "./ui/primitives/popover";

export interface ChatCommandsHelpProps {
  commands: readonly ModuleChatCommandDeclaration[];
  language?: DashboardLanguage;
  minimumRole?: string;
}

export function ChatCommandsHelp({ commands, language = dashboardLanguage(), minimumRole }: ChatCommandsHelpProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  if (commands.length === 0) return null;

  const texts = dashboardTexts(language).module;
  const buttonLabel = texts.chatCommandsButtonLabel(formatNumber(commands.length, language));
  const copyCommand = async (syntax: string): Promise<void> => {
    try {
      if (typeof navigator === "undefined") throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(syntax);
      notify({ tone: "success", message: texts.chatCommandCopied });
    } catch {
      notify({ tone: "error", message: texts.chatCommandCopyFailed });
    }
  };

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger render={<Button ariaExpanded={open} ariaHasPopup="dialog" className="chat-commands-help__trigger">{buttonLabel}</Button>} />
      <PopoverContent align="end" role="dialog" aria-label={texts.chatCommands} className="chat-command-popover">
        <strong>{texts.chatCommands}</strong>
        {commands.map((command) => (
          <article className="chat-command-help" key={command.name}>
            <div className="chat-command-help__top">
              <code>{command.syntax}</code>
              <Button variant="subtle" size="compact" icon="copy" className="chat-command-help__copy" ariaLabel={`${texts.chatCommandCopy}: ${command.syntax}`} onClick={() => { void copyCommand(command.syntax); }}>{texts.chatCommandCopy}</Button>
            </div>
            <p>{command.description[language]}</p>
            <small>{texts.chatCommandAvailableTo}: {minimumRole ?? texts.chatCommandThresholds[command.minimumChatStatus]}</small>
            {command.arguments === undefined || command.arguments.length === 0 ? null : <dl className="chat-command-help__arguments">
              {command.arguments.map((argument) => <div key={argument.name}><dt><code>{argument.name}</code></dt><dd>{argument.hint[language]}</dd></div>)}
            </dl>}
          </article>
        ))}
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
