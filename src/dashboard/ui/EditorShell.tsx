import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type SyntheticEvent } from "react";

import { FormDensity } from "./FormDensity";
import { Icon, type IconName } from "./Icon";
import { InspectorHeading } from "./Inspector";
import { DangerSection } from "./InspectorParts";
import { SaveBar, type SaveBarProps } from "./SaveBar";

export interface EditorSection {
  id: string;
  label: string;
  icon?: IconName;
  content: ReactNode;
  issue?: "error" | "warning";
}

export interface EditorInvalidField {
  id: string;
  focusId?: string;
  label: string;
  message: string;
  sectionId: string;
}

export interface EditorShellProps {
  className?: string;
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
  invalidFields?: readonly EditorInvalidField[];
  /** Reveals interaction-gated errors before the editor handles a save attempt. */
  onInvalidSave?: () => void;
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
  dangerContent?: ReactNode;
  dangerTitle?: string;
}

const fieldById = (root: HTMLElement | null, id: string): HTMLElement | undefined =>
  root === null ? undefined : [...root.querySelectorAll<HTMLElement>("[id]")].find((candidate) => candidate.id === id);

export function EditorShell({
  className,
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
  invalidFields = [],
  onInvalidSave,
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
  dangerContent,
  dangerTitle,
}: EditorShellProps) {
  const [internalSection, setInternalSection] = useState(sections[0]?.id ?? "");
  const contentRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | true | null>(null);
  const pendingValidationFocus = useRef(false);
  const activeSectionId = section ?? internalSection;
  const activeSection = sections.find((candidate) => candidate.id === activeSectionId) ?? sections[0];
  const activeIndex = useMemo(() => Math.max(0, sections.findIndex((candidate) => candidate.id === activeSection?.id)), [activeSection?.id, sections]);
  const hasInvalid = invalidFields.length > 0 || (invalid ?? sections.some((candidate) => candidate.issue === "error"));
  const closeAction = onClose === undefined || closeLabel === undefined
    ? undefined
    : { kind: "close" as const, label: closeLabel, onClick: onClose };

  useLayoutEffect(() => {
    if (pendingValidationFocus.current) {
      const firstInvalidField = invalidFields[0];
      if (firstInvalidField === undefined) {
        pendingValidationFocus.current = false;
        contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
        return;
      }
      if (firstInvalidField.sectionId !== activeSection?.id) {
        pendingFocus.current = firstInvalidField.focusId ?? firstInvalidField.id;
        const frame = window.requestAnimationFrame(() => {
          onSectionChange?.(firstInvalidField.sectionId);
          if (section === undefined) setInternalSection(firstInvalidField.sectionId);
        });
        return () => { window.cancelAnimationFrame(frame); };
      }
      pendingValidationFocus.current = false;
      pendingFocus.current = null;
      const revealedField = fieldById(contentRef.current, firstInvalidField.focusId ?? firstInvalidField.id);
      if (revealedField !== undefined && !revealedField.matches("[disabled]")) revealedField.focus();
      return;
    }
    const fieldId = pendingFocus.current;
    if (fieldId === null) return;
    pendingFocus.current = null;
    if (fieldId === true) {
      contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      return;
    }
    const field = fieldById(contentRef.current, fieldId);
    if (field !== undefined && !field.matches("[disabled]")) field.focus();
  }, [activeSection?.id, invalidFields, onSectionChange, section]);

  const selectSection = (id: string): void => {
    onSectionChange?.(id);
    if (section === undefined) setInternalSection(id);
  };

  const focusInvalidField = (field: EditorInvalidField): void => {
    const focusId = field.focusId ?? field.id;
    if (field.sectionId !== activeSection?.id) {
      pendingFocus.current = focusId;
      selectSection(field.sectionId);
      return;
    }
    const target = fieldById(contentRef.current, focusId);
    if (target !== undefined && !target.matches("[disabled]")) target.focus();
  };

  const focusFirstInvalid = (): void => {
    const firstInvalidField = invalidFields[0];
    if (firstInvalidField !== undefined) {
      focusInvalidField(firstInvalidField);
      return;
    }
    const errorSection = sections.find((candidate) => candidate.issue === "error") ?? activeSection;
    if (errorSection === undefined) return;
    if (errorSection.id === activeSection?.id) {
      contentRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])')?.focus();
      return;
    }
    pendingFocus.current = true;
    selectSection(errorSection.id);
  };

  const handleInvalidSave = (): void => {
    if (onInvalidSave !== undefined) {
      pendingValidationFocus.current = true;
      onInvalidSave();
      return;
    }
    focusFirstInvalid();
  };

  const handleSaveAttempt = (): void => {
    if (hasInvalid) {
      handleInvalidSave();
      return;
    }
    if (pending || conflict !== undefined) return;
    pendingValidationFocus.current = true;
    onInvalidSave?.();
    onSave();
  };

  const invalidStatus = invalidMessage === undefined || invalidFields.length === 0 ? undefined : (
    <>
      <span>× {invalidMessage}</span>
      <ul className="ui-save-bar__invalid-fields">
        {invalidFields.map((field) => (
          <li key={`${field.sectionId}:${field.id}`}>
            <button type="button" aria-label={`${field.label}: ${field.message}`} title={field.message} onClick={() => { focusInvalidField(field); }}>
              {field.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    handleSaveAttempt();
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
      <section className={`ui-editor-shell${className === undefined ? "" : ` ${className}`}`} aria-label={ariaLabel} onKeyDown={handleEditorKeyDown}>
        <InspectorHeading level="h3" title={title} {...(identifier === undefined ? {} : { identifier })} {...(meta === undefined ? {} : { meta })} {...(closeAction === undefined ? {} : { action: closeAction })} />
        {sections.length < 2 ? null : (
          <div className="ui-editor-shell__tabs" role="tablist" aria-label={ariaLabel} onKeyDown={handleTabKeyDown}>
            {sections.map((candidate) => {
              const active = candidate.id === activeSection?.id;
              const issue = invalidFields.some((field) => field.sectionId === candidate.id) ? "error" : candidate.issue;
              const accessibleName = issue === undefined ? candidate.label : `${candidate.label}, ${issueLabels[issue]}`;
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
                  {issue === undefined ? null : <span className={`ui-editor-shell__issue-dot ui-editor-shell__issue-dot--${issue}`} aria-hidden="true" />}
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
            {dangerContent === undefined ? null : <DangerSection title={dangerTitle ?? ""}>{dangerContent}</DangerSection>}
          </div>
        </form>
        <SaveBar
          persistent
          dirty={dirty}
          pending={pending}
          saved={saved}
          {...(error === undefined ? {} : { error })}
          invalid={hasInvalid}
          {...(invalidMessage === undefined ? {} : { invalidMessage })}
          {...(invalidStatus === undefined ? {} : { invalidStatus })}
          {...(warnings === undefined ? {} : { warnings })}
          {...(warningStatusLabel === undefined ? {} : { warningStatusLabel })}
          {...(conflict === undefined ? {} : { conflict })}
          {...(footer === undefined ? {} : { footer })}
          onSave={handleSaveAttempt}
          onInvalidSave={handleInvalidSave}
          onDiscard={onDiscard}
          saveLabel={saveLabel}
          discardLabel={discardLabel}
          savedLabel={savedLabel}
          pendingLabel={pendingLabel}
        />
      </section>
    </FormDensity.Provider>
  );
}
