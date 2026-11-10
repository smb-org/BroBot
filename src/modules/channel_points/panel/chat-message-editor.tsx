import { useRef, type ReactElement } from "react";

import { Button, Field } from "../../../dashboard/ui";
import { channelPointsPanelTexts } from "./locale";

type Language = "de" | "en";
interface ChatMessageEditorProperties {
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  language: Language;
}

const placeholders = ["{user}", "{input}", "{reward}"] as const;

export default function ChatMessageEditor({ config, onChange, language }: ChatMessageEditorProperties): ReactElement {
  const labels = channelPointsPanelTexts[language];
  const inputRef = useRef<HTMLInputElement>(null);
  const message = typeof config.message === "string" ? config.message : "";

  const changeMessage = (next: string): void => onChange({ ...config, message: next.slice(0, 500) });
  const insert = (token: string): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? message.length;
    const end = input?.selectionEnd ?? start;
    const next = `${message.slice(0, start)}${token}${message.slice(end)}`.slice(0, 500);
    const caret = Math.min(start + token.length, next.length);
    changeMessage(next);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  };

  return <div className="channel-points-chat-editor">
    <Field
      inputRef={inputRef}
      label={labels.chatMessage}
      value={message}
      maxLength={500}
      countLabel={labels.counter}
      {...(message.trim().length === 0 ? { error: labels.required } : {})}
      onChange={changeMessage}
    />
    <div className="channel-points-chat-editor__placeholders" role="group" aria-label={labels.placeholders}>
      {placeholders.map((placeholder) => <Button
        key={placeholder}
        size="compact"
        variant="subtle"
        className="channel-points-token"
        ariaLabel={labels.insertPlaceholder(placeholder)}
        onClick={() => insert(placeholder)}
      >{placeholder}</Button>)}
    </div>
  </div>;
}
