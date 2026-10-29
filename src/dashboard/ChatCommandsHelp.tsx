import { useState, type ReactElement } from "react";

import type { ModuleChatCommandDeclaration } from "../modules/contract";
import type { ModuleHowToPlayRow } from "./module-how-to-play-model";
import { dashboardLanguage, dashboardTexts, formatNumber, type DashboardLanguage } from "./locale";
import { notify } from "./ui/toast-store";
import { Button } from "./ui/Button";
import { PopoverContent, PopoverPrimitive } from "./ui/primitives/popover";

export interface ChatCommandsHelpProps {
  commands: readonly ModuleChatCommandDeclaration[];
  language?: DashboardLanguage;
  howToPlayRows?: readonly ModuleHowToPlayRow[];
  loading?: boolean;
  loadingLabel?: string;
}

export function ChatCommandsHelp({ commands, language = dashboardLanguage(), howToPlayRows = [], loading = false, loadingLabel }: ChatCommandsHelpProps): ReactElement {
  const [open, setOpen] = useState(false);
  const texts = dashboardTexts(language).module;
  const buttonLabel = texts.chatCommandsButtonLabel(formatNumber(commands.length, language));
  if (loading || (commands.length === 0 && loadingLabel !== undefined)) {
    return <Button disabled className="chat-commands-help__trigger">{loadingLabel ?? buttonLabel}</Button>;
  }

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
        {howToPlayRows.length === 0 ? null : <div className="chat-command-help__instructions">
          {howToPlayRows.map((row, index) => <p key={`${row.kind}-${String(index)}`}>
            <strong>{texts.howToPlay[row.label]}:</strong> {row.text}
          </p>)}
        </div>}
        <strong>{texts.chatCommands}</strong>
        {commands.length === 0 ? <p className="chat-command-popover__empty">{texts.chatCommandsEmpty}</p> : commands.map((command) => (
          <article className="chat-command-help" key={command.name}>
            <div className="chat-command-help__top">
              <code>{command.syntax}</code>
              <Button variant="subtle" size="compact" icon="copy" className="chat-command-help__copy" ariaLabel={`${texts.chatCommandCopy}: ${command.syntax}`} onClick={() => { void copyCommand(command.syntax); }}>{texts.chatCommandCopy}</Button>
            </div>
            <p>{command.description[language]}</p>
            <small>{texts.chatCommandAvailableTo}: {texts.chatCommandThresholds[command.minimumChatStatus]}</small>
            {command.arguments === undefined || command.arguments.length === 0 ? null : <dl className="chat-command-help__arguments">
              {command.arguments.map((argument) => <div key={argument.name}><dt><code>{argument.nameByLanguage?.[language] ?? argument.name}</code></dt><dd>{argument.hint[language]}</dd></div>)}
            </dl>}
          </article>
        ))}
      </PopoverContent>
    </PopoverPrimitive.Root>
  );
}
