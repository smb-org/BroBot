import { useId, type ReactNode } from "react";

import { Icon } from "./Icon";

export function InspectorSection({ title, children, danger = false, help }: { title: ReactNode; children: ReactNode; danger?: boolean; help?: string }) {
  const headingId = useId();
  return (
    <section className={`inspector-content-section${danger ? " inspector-content-section--danger" : ""}`} aria-labelledby={headingId}>
      <h3 id={headingId} className="inspector-content-section__heading"><span>{title}</span>{help === undefined ? null : <button className="inspector-field-row__info" type="button" title={help} aria-label={help}><Icon name="cause" size={16} /></button>}</h3>
      <div className="inspector-content-section__body">{children}</div>
    </section>
  );
}

export function InspectorFieldRow({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="inspector-field-row">
      <div className="inspector-field-row__label">
        <span>{label}</span>
        {help === undefined ? null : <button className="inspector-field-row__info" type="button" title={help} aria-label={`${label}: ${help}`}><Icon name="cause" size={16} /></button>}
      </div>
      <div className="inspector-field-row__control">{children}</div>
    </div>
  );
}

export function InspectorActions({ children }: { children: ReactNode }) {
  return <div className="inspector-actions">{children}</div>;
}

export function DangerSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <InspectorSection title={title} danger>{children}</InspectorSection>;
}
