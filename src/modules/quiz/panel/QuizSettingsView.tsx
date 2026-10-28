import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import { refetchModuleQueryData, runModuleQueryWrite, useDashboardQueryClient } from "../../../dashboard/data";
import {
  ConfirmDialog,
  SettingsEditor,
  registerDashboardNavigationGuard,
  useDraft,
  useDraftGuard,
} from "../../../dashboard/ui";
import type { SaveStatusProps } from "../../../dashboard/ui/SaveStatus";
import { quizSettingsSchema } from "../contracts";
import { quizPanelTexts } from "../locale";
import type { QuizEditorControl } from "./QuizSetEditor";
import { quizErrorCode, saveQuizSettings, type QuizSettingsState } from "./service";
import { quizSettingsSpec } from "./settings-editor";
import { quizSettingsEditorCatalog } from "./settings-editor-locale";
import "./panel.css";

interface QuizSettingsViewProperties {
  channelId: string;
  language: "de" | "en";
  canManage: boolean;
  state: QuizSettingsState;
  onRegisterEditor: (editor: QuizEditorControl) => () => void;
  onSaveStatus: (session: symbol, status: SaveStatusProps) => void;
}

export default function QuizSettingsView({ channelId, language, canManage, state, onRegisterEditor, onSaveStatus }: QuizSettingsViewProperties): ReactElement {
  const labels = useMemo(() => quizPanelTexts(language), [language]);
  const copy = quizSettingsEditorCatalog[language];
  const queryClient = useDashboardQueryClient();
  const session = useMemo(() => Symbol("quiz-settings"), []);
  const draft = useDraft(state.settings);
  const { value, setValue, dirty, reset, accept } = draft;
  const [revision, setRevision] = useState(state.revision);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [conflicted, setConflicted] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const saveInFlight = useRef<Promise<string | null> | null>(null);
  const dirtyRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { dirtyRef.current = dirty; }, [dirty]);

  const parsed = useMemo(() => quizSettingsSchema.safeParse(value), [value]);
  const fieldErrors = useMemo<Readonly<Record<string, string>>>(() => {
    if (!attempted || parsed.success) return {};
    return Object.fromEntries(parsed.error.issues.flatMap((issue) => {
      const key = String(issue.path[0]);
      return [[key, copy.fields[key]?.invalidError ?? copy.invalidMessage] as const];
    }));
  }, [attempted, copy, parsed]);

  const discard = useCallback((): void => {
    reset();
    setError(undefined);
    setSaved(false);
    setAttempted(false);
  }, [reset]);

  const save = useCallback((): Promise<string | null> => {
    if (saveInFlight.current !== null) return saveInFlight.current;
    if (!canManage) return Promise.resolve(copy.saveError);
    if (!parsed.success) {
      setAttempted(true);
      return Promise.resolve(copy.invalidMessage);
    }
    const submitted = parsed.data;
    setSaving(true);
    setError(undefined);
    setConflicted(false);
    const operation = (async (): Promise<string | null> => {
      try {
        const result = await runModuleQueryWrite(
          queryClient,
          channelId,
          "quiz",
          "settings",
          (currentRevision) => saveQuizSettings(channelId, currentRevision ?? revision, submitted),
          { baselineRevision: revision, updateCache: (_current, next) => next },
        );
        if (mounted.current) {
          accept(result.settings);
          setRevision(result.revision);
          setSaved(true);
          setAttempted(false);
        }
        return null;
      } catch (failure: unknown) {
        const conflict = quizErrorCode(failure) === "module_settings_changed_concurrently";
        const message = conflict ? copy.conflictMessage : copy.saveError;
        if (mounted.current) {
          setConflicted(conflict);
          setError(message);
        }
        return message;
      } finally {
        if (mounted.current) setSaving(false);
        saveInFlight.current = null;
      }
    })();
    saveInFlight.current = operation;
    return operation;
  }, [accept, canManage, channelId, copy, parsed, queryClient, revision]);

  const reloadConflict = useCallback(async (): Promise<void> => {
    setReloading(true);
    try {
      const latest = await refetchModuleQueryData<QuizSettingsState>(queryClient, channelId, "quiz", "settings");
      if (!mounted.current) return;
      accept(latest.settings);
      setRevision(latest.revision);
      setConflicted(false);
      setError(undefined);
      setSaved(false);
    } catch {
      // Keep the draft and the conflict notice when the reload fails.
    } finally {
      if (mounted.current) setReloading(false);
    }
  }, [accept, channelId, queryClient]);

  const guard = useDraftGuard(dirty, save, discard);
  const control = useMemo<QuizEditorControl>(() => ({
    session,
    guardSwitch: guard.guardSwitch,
    isDirty: () => dirtyRef.current,
  }), [guard.guardSwitch, session]);
  useEffect(() => onRegisterEditor(control), [control, onRegisterEditor]);
  useEffect(() => registerDashboardNavigationGuard(guard.guardSwitch), [guard.guardSwitch]);

  const statusProps = useMemo<SaveStatusProps>(() => ({
    persistent: true,
    dirty,
    pending: saving,
    saved,
    ...(error === undefined ? {} : { error }),
    invalid: !parsed.success,
    invalidMessage: copy.invalidMessage,
    ...(conflicted ? {
      conflict: {
        message: copy.conflictMessage,
        reloadLabel: copy.reloadLabel,
        reloadPending: reloading,
        onReload: () => { void reloadConflict(); },
      },
    } : {}),
    onSave: () => { void save(); },
    onInvalidSave: () => { setAttempted(true); },
    onDiscard: discard,
    saveLabel: copy.saveLabel,
    discardLabel: copy.discardLabel,
    savedLabel: copy.savedLabel,
    pendingLabel: copy.pendingLabel,
    saveDisabled: !canManage,
    discardDisabled: !canManage,
  }), [canManage, conflicted, copy, dirty, discard, error, parsed.success, reloadConflict, reloading, save, saved, saving]);
  useEffect(() => { onSaveStatus(session, statusProps); }, [onSaveStatus, session, statusProps]);

  return <>
    <section className="quiz-settings" aria-label={copy.ariaLabel}>
      <h2 className="quiz-settings__title">{copy.title}</h2>
      {quizSettingsSpec.sections.map((section) => (
        <SettingsEditor
          key={section.id}
          spec={quizSettingsSpec}
          sectionId={section.id}
          settings={value}
          onChange={(key, next) => {
            setValue((current) => ({ ...current, [key]: next }));
            setSaved(false);
            setError(undefined);
          }}
          texts={copy}
          templateMessages={copy.templateMessages}
          disabled={!canManage || saving}
          fieldErrors={fieldErrors}
          idPrefix="quiz-settings"
        />
      ))}
    </section>
    <ConfirmDialog
      opened={guard.confirmOpen}
      title={labels.unsavedTitle}
      description={labels.unsavedDescription}
      confirmLabel={labels.saveAndContinue}
      cancelLabel={labels.continueEditing}
      alternative={{ label: labels.discardAndSwitch, onClick: guard.discardAndSwitch }}
      onConfirm={() => { void guard.saveAndSwitch(); }}
      onCancel={guard.continueEditing}
      pending={guard.saving}
      {...(guard.saveError === undefined ? {} : { error: guard.saveError })}
    />
  </>;
}
