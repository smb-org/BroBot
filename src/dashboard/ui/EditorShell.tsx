import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";

import { FormDensity } from "./FormDensity";
import { Icon, type IconName } from "./Icon";
import { InspectorHeading } from "./Inspector";
import { SaveBar, type SaveBarProps } from "./SaveBar";

export interface EditorSection {
  id: string;
  label: string;
  icon?: IconName;
  content: ReactNode;
  issue?: "error" | "warning";
}

export interface EditorShellProps {
  ariaLabel: string;
  title: ReactNode;
  identifier?: string;
  meta?: ReactNode;
  sections: readonly EditorSection[];
  section?: string;
  onSectionChange?: (id: string) => void;
  readOnly?: { reason: string; content: ReactNode };
  dirty: boolean;
  pending?: boolean;
  saved?: boolean;
  error?: string;
  invalid?: boolean;
  invalidMessage?: string;
  warnings?: readonly string[];
  warningStatusLabel?: SaveBarProps["warningStatusLabel"];
  conflict?: { message: string; reloadLabel: string; onReload: () => void };
  onSave: () => void;
  onDiscard: () => void;
  saveLabel: string;
  discardLabel: string;
  savedLabel: string;
  pendingLabel: string;
  issueLabels: { error: string; warning: string };
  onClose?: () => void;
  closeLabel?: string;
  footer?: ReactNode;
}

export function EditorShell({
  ariaLabel,
  title,
  identifier,
  meta,
  sections,
  section,
  onSectionChange,
  readOnly,
  dirty,
  pending = false,
  saved = false,
  error,
  invalid,
  invalidMessage,
  warnings,
  warningStatusLabel,
  conflict,
  onSave,
  onDiscard,
  saveLabel,
  discardLabel,
  savedLabel,
  pendingLabel,
  issueLabels,
  onClose,
  closeLabel,
  footer,
}: EditorShellProps) {
  const [internalSection, setInternalSection] = useState(sections[0]?.id ?? "");
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const activeSectionId = section ?? internalSection;
  const activeSection = sections.find((candidate) => candidate.id === activeSectionId) ?? sections[0];
  const activeIndex = useMemo(() => Math.max(0, sections.findIndex((candidate) => candidate.id === activeSection?.id)), [activeSection?.id, sections]);
  const hasInvalid = invalid ?? sections.some((candidate) => candidate.issue === "error");
  const closeAction = onClose === undefined || closeLabel === undefined
    ? undefined
    : { kind: "close" as const, label: closeLabel, onClick: onClose };

  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
  }, [activeSection?.id]);

  const selectSection = (id: string): void => {
    onSectionChange?.(id);
    if (section === undefined) setInternalSection(id);
  };

  const focusFirstInvalid = (): void => {
    const errorSection = sections.find((candidate) => candidate.issue === "error") ?? activeSection;
    if (errorSection === undefined) return;
    if (errorSection.id === activeSection?.id) {
      contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      return;
    }
    pendingFocus.current = true;
    selectSection(errorSection.id);
  };

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (hasInvalid) focusFirstInvalid();
    else if (!pending && conflict === undefined) onSave();
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || onClose === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>("[role='tab']");
    if (tab === null || sections.length < 2) return;
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (activeIndex + 1) % sections.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (activeIndex - 1 + sections.length) % sections.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? sections.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = sections[nextIndex];
    if (next === undefined) return;
    selectSection(next.id);
    window.requestAnimationFrame(() => document.getElementById(`editor-tab-${next.id}`)?.focus());
  };

  if (readOnly !== undefined) {
    return (
      <section className="ui-editor-shell ui-editor-shell--readonly" aria-label={ariaLabel} onKeyDown={handleEditorKeyDown}>
        <InspectorHeading level="h3" title={title} {...(identifier === undefined ? {} : { identifier })} {...(meta === undefined ? {} : { meta })} {...(closeAction === undefined ? {} : { action: closeAction })} />
        <div className="ui-editor-shell__readonly-reason"><Icon name="lock" size={16} /><span>{readOnly.reason}</span></div>
        {readOnly.content}
      </section>
    );
  }

  return (
    <FormDensity.Provider value="form">
      <section className="ui-editor-shell" aria-label={ariaLabel} onKeyDown={handleEditorKeyDown}>
        <InspectorHeading level="h3" title={title} {...(identifier === undefined ? {} : { identifier })} {...(meta === undefined ? {} : { meta })} {...(closeAction === undefined ? {} : { action: closeAction })} />
        {sections.length < 2 ? null : (
          <div className="ui-editor-shell__tabs" role="tablist" aria-label={ariaLabel} onKeyDown={handleTabKeyDown}>
            {sections.map((candidate) => {
              const active = candidate.id === activeSection?.id;
              const accessibleName = candidate.issue === undefined ? candidate.label : `${candidate.label}, ${issueLabels[candidate.issue]}`;
              return (
                <button
                  className="ui-editor-shell__tab"
                  id={`editor-tab-${candidate.id}`}
                  key={candidate.id}
                  type="button"
                  role="tab"
                  aria-label={accessibleName}
                  aria-selected={active}
                  aria-controls={active ? `editor-panel-${candidate.id}` : undefined}
                  tabIndex={active ? 0 : -1}
                  onClick={() => { selectSection(candidate.id); }}
                >
                  {candidate.icon === undefined ? null : <Icon name={candidate.icon} size={16} />}
                  <span>{candidate.label}</span>
                  {candidate.issue === undefined ? null : <span className={`ui-editor-shell__issue-dot ui-editor-shell__issue-dot--${candidate.issue}`} aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        )}
        <form className="ui-editor-shell__form" onSubmit={handleSubmit}>
          <div className="ui-editor-shell__body" ref={contentRef}>
            {activeSection === undefined ? null : (
              <div
                className="ui-editor-shell__panel"
                id={`editor-panel-${activeSection.id}`}
                role="tabpanel"
                aria-labelledby={sections.length < 2 ? undefined : `editor-tab-${activeSection.id}`}
                tabIndex={0}
              >
                {activeSection.content}
              </div>
            )}
          </div>
          <SaveBar
            persistent
            dirty={dirty}
            pending={pending}
            saved={saved}
            {...(error === undefined ? {} : { error })}
            invalid={hasInvalid}
            {...(invalidMessage === undefined ? {} : { invalidMessage })}
            {...(warnings === undefined ? {} : { warnings })}
            {...(warningStatusLabel === undefined ? {} : { warningStatusLabel })}
            {...(conflict === undefined ? {} : { conflict })}
            {...(footer === undefined ? {} : { footer })}
            onSave={onSave}
            onInvalidSave={focusFirstInvalid}
            onDiscard={onDiscard}
            saveLabel={saveLabel}
            discardLabel={discardLabel}
            savedLabel={savedLabel}
            pendingLabel={pendingLabel}
          />
        </form>
      </section>
    </FormDensity.Provider>
  );
}
