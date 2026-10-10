import { useCallback, useEffect, useRef, useState } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { notify } from "../../../dashboard/ui";
import { CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS, type ChatVoteTemplate, type ChatVoteTemplateDraft } from "../contracts";
import { isValidTemplateShortcut } from "../domain";
import { chatVotingSavedPanelTexts } from "./locale-saved";
import { loadChatVoteTemplates, saveChatVoteTemplate } from "./service";
import type { TemplateSaveState } from "./template-inspector";

const draftFrom = (template: ChatVoteTemplate): ChatVoteTemplateDraft => ({
  shortcut: template.shortcut,
  title: template.title,
  labels: [...template.labels],
  freeTextMode: template.freeTextMode,
  durationSeconds: template.durationSeconds,
});

const sameDraft = (left: ChatVoteTemplateDraft, right: ChatVoteTemplateDraft): boolean =>
  left.shortcut === right.shortcut && left.title === right.title && left.freeTextMode === right.freeTextMode &&
  left.durationSeconds === right.durationSeconds && left.labels.length === right.labels.length &&
  left.labels.every((label, index) => label === right.labels[index]);

export interface ChatVoteTemplateAutosave {
  draftFor: (template: ChatVoteTemplate) => ChatVoteTemplateDraft;
  stateFor: (template: ChatVoteTemplate) => TemplateSaveState;
  shortcutErrorFor: (template: ChatVoteTemplate) => string | null;
  change: (template: ChatVoteTemplate, update: Partial<ChatVoteTemplateDraft>) => void;
  flush: (templateId: string, keepalive?: boolean) => Promise<boolean>;
  flushAll: (keepalive?: boolean) => Promise<boolean>;
  reset: (template: ChatVoteTemplate) => void;
  clear: (templateId: string) => void;
}

export const useChatVoteTemplateAutosave = (
  channelId: string,
  templates: readonly ChatVoteTemplate[],
  language: "de" | "en",
  replaceTemplate: (template: ChatVoteTemplate) => void,
): ChatVoteTemplateAutosave => {
  const labels = chatVotingSavedPanelTexts(language);
  const templatesRef = useRef(new Map<string, ChatVoteTemplate>());
  const draftsRef = useRef(new Map<string, ChatVoteTemplateDraft>());
  const dirtyRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, number>());
  const queuesRef = useRef(new Map<string, Promise<boolean>>());
  const [revision, setRevision] = useState(0);
  const [states, setStates] = useState(new Map<string, TemplateSaveState>());
  const [shortcutErrors, setShortcutErrors] = useState(new Map<string, string>());

  templatesRef.current = new Map(templates.map((template) => [template.id, template]));
  const updateState = useCallback((id: string, state: TemplateSaveState): void => {
    setStates((current) => new Map(current).set(id, state));
  }, []);
  const updateShortcutError = useCallback((id: string, error: string | null): void => {
    setShortcutErrors((current) => {
      const next = new Map(current);
      if (error === null) next.delete(id);
      else next.set(id, error);
      return next;
    });
  }, []);
  const updateTemplate = useCallback((template: ChatVoteTemplate): void => {
    templatesRef.current.set(template.id, template);
    replaceTemplate(template);
  }, [replaceTemplate]);

  const shortcutProblem = useCallback((id: string, value: string | null): string | null => {
    if (value === null || value.length === 0) return null;
    const current = templatesRef.current.get(id);
    const reserved = (CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS as readonly string[]).includes(value);
    if (!isValidTemplateShortcut(value)) return reserved ? labels.shortcutReserved : labels.shortcutInvalid;
    if ([...templatesRef.current.values()].some((template) => template.id !== id && template.shortcut === value)) {
      return labels.shortcutDuplicate;
    }
    if (current?.shortcut === value) return null;
    return null;
  }, [labels.shortcutDuplicate, labels.shortcutInvalid, labels.shortcutReserved]);

  const saveOne = useCallback(async (id: string, keepalive = false): Promise<boolean> => {
    const template = templatesRef.current.get(id);
    if (template === undefined) return true;
    const draft = draftsRef.current.get(id) ?? draftFrom(template);
    const shortcutError = shortcutProblem(id, draft.shortcut);
    updateShortcutError(id, shortcutError);
    const safeDraft: ChatVoteTemplateDraft = {
      ...draft,
      shortcut: shortcutError === null ? draft.shortcut || null : template.shortcut,
    };
    if (sameDraft(safeDraft, draftFrom(template))) {
      dirtyRef.current.delete(id);
      updateState(id, "saved");
      setRevision((current) => current + 1);
      return true;
    }

    updateState(id, "saving");
    const applySaved = (saved: ChatVoteTemplate, sent: ChatVoteTemplateDraft): boolean => {
      updateTemplate(saved);
      const latestDraft = draftsRef.current.get(id) ?? sent;
      const latestProblem = shortcutProblem(id, latestDraft.shortcut);
      const latestSafe: ChatVoteTemplateDraft = {
        ...latestDraft,
        shortcut: latestProblem === null ? latestDraft.shortcut || null : saved.shortcut,
      };
      if (sameDraft(latestSafe, draftFrom(saved))) dirtyRef.current.delete(id);
      updateState(id, "saved");
      setRevision((current) => current + 1);
      return !dirtyRef.current.has(id);
    };

    try {
      const saved = await saveChatVoteTemplate(channelId, template, safeDraft, keepalive);
      return applySaved(saved, safeDraft);
    } catch (error: unknown) {
      let saveError: unknown = error;
      if (saveError instanceof PanelApiError && saveError.code === "chat_vote_template_shortcut_conflict" && shortcutError === null) {
        updateShortcutError(id, labels.shortcutDuplicate);
        const fallback = { ...safeDraft, shortcut: template.shortcut };
        try {
          const saved = await saveChatVoteTemplate(channelId, template, fallback, keepalive);
          return applySaved(saved, fallback);
        } catch (retryError: unknown) {
          saveError = retryError;
        }
      }
      if (saveError instanceof PanelApiError && saveError.status === 409 && saveError.code === "chat_vote_template_conflict") {
        try {
          const latest = (await loadChatVoteTemplates(channelId)).templates.find((entry) => entry.id === id);
          if (latest !== undefined) {
            const focused = document.activeElement;
            const focusedInput = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
            const focusedValue = focusedInput?.value;
            const selectionStart = focusedInput?.selectionStart;
            const selectionEnd = focusedInput?.selectionEnd;
            const idStart = focusedInput?.id.indexOf("chat-vote-") ?? -1;
            const field = idStart < 0 ? null : focusedInput?.id.slice(idStart + "chat-vote-".length);
            let remoteValue: string | null = null;
            if (field === "title-" + id) remoteValue = latest.title;
            else if (field === "shortcut-" + id) remoteValue = latest.shortcut ?? "";
            else if (field?.startsWith("answer-" + id + "-")) {
              const index = Number(field.slice(("answer-" + id + "-").length));
              remoteValue = latest.labels[index] ?? "";
            }
            updateTemplate(latest);
            draftsRef.current.set(id, draftFrom(latest));
            dirtyRef.current.delete(id);
            updateShortcutError(id, null);
            updateState(id, "conflict");
            notify({ tone: "error", message: labels.saveConflictToast(latest.title.trim() || labels.untitled) });
            if (focusedInput !== null && remoteValue === focusedValue && selectionStart !== null && selectionStart !== undefined && selectionEnd !== null && selectionEnd !== undefined) {
              window.requestAnimationFrame(() => {
                if (!focusedInput.isConnected) return;
                focusedInput.focus();
                focusedInput.setSelectionRange(selectionStart, selectionEnd);
              });
            }
            setRevision((current) => current + 1);
            return false;
          }
        } catch {
          // The stale local draft remains available when the reload itself fails.
        }
      }
      updateState(id, "error");
      notify({ tone: "error", message: labels.saveError });
      setRevision((current) => current + 1);
      return false;
    }
  }, [channelId, labels, shortcutProblem, updateShortcutError, updateState, updateTemplate]);

  const enqueue = useCallback((id: string, keepalive = false): Promise<boolean> => {
    const previous = queuesRef.current.get(id) ?? Promise.resolve(true);
    const next = previous.catch(() => false).then(() => saveOne(id, keepalive));
    queuesRef.current.set(id, next);
    return next;
  }, [saveOne]);

  const flush = useCallback(async (id: string, keepalive = false): Promise<boolean> => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    let attempts = 0;
    while (dirtyRef.current.has(id) && attempts < 8) {
      attempts += 1;
      if (!await enqueue(id, keepalive)) return false;
    }
    return !dirtyRef.current.has(id);
  }, [enqueue]);

  const flushAll = useCallback(async (keepalive = false): Promise<boolean> => {
    const ids = [...dirtyRef.current];
    const results = await Promise.all(ids.map((id) => flush(id, keepalive)));
    return results.every(Boolean);
  }, [flush]);

  const schedule = useCallback((id: string): void => {
    const previous = timersRef.current.get(id);
    if (previous !== undefined) window.clearTimeout(previous);
    timersRef.current.set(id, window.setTimeout(() => {
      timersRef.current.delete(id);
      void flush(id);
    }, 600));
  }, [flush]);

  const draftFor = useCallback((template: ChatVoteTemplate): ChatVoteTemplateDraft => {
    void revision;
    return draftsRef.current.get(template.id) ?? draftFrom(template);
  }, [revision]);
  const stateFor = useCallback((template: ChatVoteTemplate): TemplateSaveState => states.get(template.id) ?? "saved", [states]);
  const shortcutErrorFor = useCallback((template: ChatVoteTemplate): string | null => shortcutErrors.get(template.id) ?? null, [shortcutErrors]);
  const change = useCallback((template: ChatVoteTemplate, update: Partial<ChatVoteTemplateDraft>): void => {
    const current = draftsRef.current.get(template.id) ?? draftFrom(template);
    const next = { ...current, ...update };
    draftsRef.current.set(template.id, next);
    const latestTemplate = templatesRef.current.get(template.id) ?? template;
    const problem = shortcutProblem(template.id, next.shortcut);
    updateShortcutError(template.id, problem);
    const projected = { ...next, shortcut: problem === null ? next.shortcut || null : latestTemplate.shortcut };
    if (sameDraft(projected, draftFrom(latestTemplate))) dirtyRef.current.delete(template.id);
    else dirtyRef.current.add(template.id);
    setRevision((currentRevision) => currentRevision + 1);
    schedule(template.id);
  }, [schedule, shortcutProblem, updateShortcutError]);
  const reset = useCallback((template: ChatVoteTemplate): void => {
    draftsRef.current.set(template.id, draftFrom(template));
    dirtyRef.current.delete(template.id);
    updateShortcutError(template.id, null);
    updateState(template.id, "saved");
    setRevision((currentRevision) => currentRevision + 1);
  }, [updateShortcutError, updateState]);
  const clear = useCallback((id: string): void => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    draftsRef.current.delete(id);
    dirtyRef.current.delete(id);
    updateShortcutError(id, null);
    setStates((current) => { const next = new Map(current); next.delete(id); return next; });
  }, [updateShortcutError]);

  useEffect(() => {
    const onPageHide = (): void => { void flushAll(true); };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void flushAll(true);
    };
  }, [channelId, flushAll]);

  return { draftFor, stateFor, shortcutErrorFor, change, flush, flushAll, reset, clear };
};
