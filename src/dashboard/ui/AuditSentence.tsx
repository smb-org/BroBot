import type { ReactElement } from "react";

export type AuditSentenceProps = { sentence: string } | {
  who: string;
  action: string;
  what?: string | null;
  fromLabel: string;
  from?: string | null;
  to?: string | null;
};

export function AuditSentence(props: AuditSentenceProps): ReactElement {
  if ("sentence" in props) return <span className="audit-sentence">{props.sentence}</span>;
  const { who, action, what, fromLabel, from, to } = props;
  return (
    <span className="audit-sentence">
      <span className="audit-sentence__chip audit-sentence__chip--who">{who}</span>
      <span className="audit-sentence__action">{action}</span>
      {what === null || what === undefined || what.length === 0 ? null : <span className="audit-sentence__chip">{what}</span>}
      {from == null && to == null ? null : from != null && to != null ? <>
        <span className="audit-sentence__connector">{fromLabel}</span>
        <span className="audit-sentence__chip audit-sentence__chip--value">{from}</span>
        <span className="audit-sentence__arrow" aria-hidden="true">→</span>
        <span className="audit-sentence__chip audit-sentence__chip--value">{to}</span>
      </> : <span className="audit-sentence__chip audit-sentence__chip--value">{to ?? from}</span>}
    </span>
  );
}
