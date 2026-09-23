export type LedStatus = "green" | "amber" | "red" | "off";

export interface LedProps {
  status: LedStatus;
  /** "Green never stands without a word next to it" -- there is no
   *  optional-word escape hatch here on purpose. */
  word: string;
  /** Renders only the state dot for dense navigation entries. */
  dotOnly?: boolean;
}

/**
 * "The LED-with-word rule": color alone never carries state. Mantine's
 * `Badge`/`Indicator` are deliberately not used -- see "LED" in
 * the dashboard design document. Status colors are selected in the shared
 * dashboard stylesheet from the same state tokens as the theme.
 */
export function Led({ status, word, dotOnly = false }: LedProps) {
  return (
    <span className={`led${dotOnly ? " led--dot-only" : ""}`} data-status={status} aria-hidden={dotOnly ? true : undefined}>
      <span className="led__dot" aria-hidden="true" />
      {dotOnly ? null : <span>{word}</span>}
    </span>
  );
}
