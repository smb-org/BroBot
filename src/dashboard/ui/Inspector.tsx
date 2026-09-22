import { type KeyboardEvent, type ReactElement, type ReactNode, type Ref } from "react";

interface InspectorHeadingAction {
  kind: "close" | "add";
  label: string;
  onClick: () => void;
}

interface InspectorHeadingProperties {
  level: "h2" | "h3";
  title: ReactNode;
  identifier?: string | undefined;
  meta?: ReactNode;
  action?: InspectorHeadingAction;
  buttonRef?: Ref<HTMLButtonElement>;
}

export const InspectorHeading = ({ level, title, identifier, meta, action, buttonRef }: InspectorHeadingProperties): ReactElement => {
  const Heading = level;
  const className = level === "h2" ? "section-heading" : "inspector-section__heading";
  const path = action?.kind === "add" ? "M12 5v14M5 12h14" : "M6 6l12 12M18 6 6 18";
  return (
    <div className={className}>
      <Heading title={identifier}>{title}</Heading>
      {meta}
      {action === undefined ? null : (
        <button ref={buttonRef} className="button button--quiet inspector-close" type="button" aria-label={action.label} onClick={action.onClick}>
          <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={path} />
          </svg>
        </button>
      )}
    </div>
  );
};

interface SubInspectorProperties {
  ariaLabel: string;
  title: ReactNode;
  identifier?: string | undefined;
  meta?: ReactNode;
  className?: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export const SubInspector = ({ ariaLabel, title, identifier, meta, className, closeLabel, onClose, children }: SubInspectorProperties): ReactElement => {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section className={`command-inspector sub-inspector${className === undefined ? "" : ` ${className}`}`} aria-label={ariaLabel} onKeyDown={handleKeyDown}>
      <InspectorHeading level="h3" title={title} identifier={identifier} meta={meta} action={{ kind: "close", label: closeLabel, onClick: onClose }} />
      {children}
    </section>
  );
};
