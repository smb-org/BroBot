import { type KeyboardEvent, type ReactElement, type ReactNode } from "react";

interface SubInspectorProperties {
  ariaLabel: string;
  title: ReactNode;
  identifier?: ReactNode;
  className?: string;
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export const SubInspector = ({ ariaLabel, title, identifier, className, closeLabel, onClose, children }: SubInspectorProperties): ReactElement => {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section className={`command-inspector sub-inspector${className === undefined ? "" : ` ${className}`}`} aria-label={ariaLabel} onKeyDown={handleKeyDown}>
      <div className="inspector-section__heading">
        <h3>{title}</h3>
        {identifier === undefined ? null : <span className="mono muted">{identifier}</span>}
        <button className="button button--quiet inspector-close" type="button" aria-label={closeLabel} onClick={onClose}>
          <svg className="inspector-close__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
      {children}
    </section>
  );
};
