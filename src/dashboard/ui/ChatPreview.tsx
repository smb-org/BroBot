import type { ReactElement, ReactNode } from "react";

export interface ChatPreviewProps {
  /** e.g. "Vorschau" or "Preview" */
  label: string;
  /** e.g. "Bot" */
  speaker: string;
  text: string;
  emptyText?: string;
  /** e.g. "42 characters" */
  countLabel: ReactNode;
}

/** Fixed-height display of a two-line chat message with its preview label. */
export function ChatPreview({ label, speaker, text, emptyText, countLabel }: ChatPreviewProps): ReactElement {
  const displayText = text.trim().length === 0 ? emptyText ?? text : text;
  return (
    <div data-ui="" className="ui-chat-preview">
      <span className="ui-chat-preview__label">{label}</span>
      <p className="ui-chat-preview__message" title={`${speaker}: ${displayText}`}>
        <span className="ui-chat-preview__speaker">{speaker}</span>
        <span className="ui-chat-preview__colon" aria-hidden="true">:</span>{" "}
        <span className="ui-chat-preview__text" title={displayText}>{displayText}</span>
      </p>
      <span className="ui-chat-preview__count">{countLabel}</span>
    </div>
  );
}
