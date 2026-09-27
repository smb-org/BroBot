import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "./Icon";

function InfoButton({ label, help }: { label: string; help: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pointerActivation = useRef(false);
  useEffect(() => {
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => { document.removeEventListener("pointerdown", closeOutside); };
  }, []);
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
  };
  return <span ref={root} className="inspector-info">
    <button
      ref={button}
      className="inspector-field-row__info"
      type="button"
      title={help}
      aria-label={`${label}: ${help}`}
      aria-expanded={open}
      {...(open ? { "aria-describedby": id } : {})}
      onPointerDown={() => { pointerActivation.current = true; }}
      onFocus={() => { if (!pointerActivation.current) setOpen(true); }}
      onBlur={(event) => { if (!(event.relatedTarget instanceof Node) || !root.current?.contains(event.relatedTarget)) setOpen(false); }}
      onClick={() => { setOpen((current) => !current); pointerActivation.current = false; }}
      onKeyDown={handleKeyDown}
    ><Icon name="cause" size={16} /></button>
    {open ? <span className="inspector-info__tooltip" id={id} role="tooltip">{help}</span> : null}
  </span>;
}

export function InspectorSection({ title, children, danger = false, help }: { title: ReactNode; children: ReactNode; danger?: boolean; help?: string }) {
  const headingId = useId();
  return (
    <section className={`inspector-content-section${danger ? " inspector-content-section--danger" : ""}`} aria-labelledby={headingId}>
      <h3 id={headingId} className="inspector-content-section__heading"><span>{title}</span>{help === undefined ? null : <InfoButton label={typeof title === "string" ? title : help} help={help} />}</h3>
      <div className="inspector-content-section__body">{children}</div>
    </section>
  );
}

export function InspectorFieldRow({ label, help, children, className }: { label: string; help?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`inspector-field-row${className === undefined ? "" : ` ${className}`}`}>
      <div className="inspector-field-row__label">
        <span>{label}</span>
        {help === undefined ? null : <InfoButton label={label} help={help} />}
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
