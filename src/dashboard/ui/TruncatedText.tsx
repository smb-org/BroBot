import type { ReactElement } from "react";

interface TruncatedTextProps {
  text: string;
  className?: string;
}

/** One-line visible copy with a native title and complete screen-reader text. */
export function TruncatedText({ text, className }: TruncatedTextProps): ReactElement {
  return (
    <>
      <span className={["ui-truncated-text", className].filter(Boolean).join(" ")} title={text} data-text={text} aria-hidden="true" />
      <span className="sr-only">{text}</span>
    </>
  );
}
