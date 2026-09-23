import type { ReactElement, ReactNode } from "react";

export interface ChatPreviewProps {
  /** e.g. "Preview" */
  label: string;
  /** e.g. "Bot" */
  speaker: string;
  text: string;
  /** e.g. "42 characters" */
  countLabel: ReactNode;
}

/** The "Preview · Bot · …" chat-message row shared by every response preview
 *  (template text and the command-list preview alike). */
export function ChatPreview({ label, speaker, text, countLabel }: ChatPreviewProps): ReactElement {
  return (
    <div className="ui-chat-preview">
      <span className="ui-chat-preview__label">{label}</span>
      <span className="ui-chat-preview__speaker">{speaker}</span>
      <span className="ui-chat-preview__text">{text}</span>
      <span className="ui-chat-preview__count">{countLabel}</span>
    </div>
  );
}
