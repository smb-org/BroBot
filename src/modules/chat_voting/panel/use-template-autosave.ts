import { useCallback, useEffect, useRef, useState } from "react";

import { PanelApiError } from "../../../contracts/panel-error";
import { notify } from "../../../dashboard/ui";
import { CHAT_VOTE_TEMPLATE_RESERVED_SHORTCUTS, type ChatVoteTemplate, type ChatVoteTemplateDraft } from "../contracts";
import { isValidTemplateShortcut } from "../domain";
import { chatVotingSavedPanelTexts } from "./locale-saved";
import { loadChatVoteTemplates, primeChatVotingCsrfToken, saveChatVoteTemplate } from "./service";
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

interface TemplateDraftEntry {
  baseRevision: number;
  acknowledged: ChatVoteTemplateDraft;
  draft: ChatVoteTemplateDraft;
}

const isTemplateDraft = (value: unknown): value is ChatVoteTemplateDraft => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (draft.shortcut === null || typeof draft.shortcut === "string") &&
    typeof draft.title === "string" && Array.isArray(draft.labels) && draft.labels.every((label) => typeof label === "string") &&
    (draft.freeTextMode === null || draft.freeTextMode === "first_word" || draft.freeTextMode === "whole_message") &&
    typeof draft.durationSeconds === "number" && Number.isSafeInteger(draft.durationSeconds);
};

const isTemplateDraftEntry = (value: unknown): value is TemplateDraftEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.baseRevision === "number" && Number.isSafeInteger(entry.baseRevision) && entry.baseRevision > 0 &&
    isTemplateDraft(entry.acknowledged) && isTemplateDraft(entry.draft);
};

const pendingDraftsKey = (channelId: string): string => `chat-voting-template-drafts:${encodeURIComponent(channelId)}`;

const readPendingDrafts = (channelId: string): Map<string, TemplateDraftEntry> => {
  try {
    const raw = window.sessionStorage.getItem(pendingDraftsKey(channelId));
    if (raw === null) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter((entry): entry is [string, TemplateDraftEntry] => isTemplateDraftEntry(entry[1])));
  } catch { return new Map(); }
};

const writePendingDraft = (channelId: string, id: string, entry: TemplateDraftEntry): void => {
  try {
    const pending = readPendingDrafts(channelId);
    pending.set(id, entry);
    window.sessionStorage.setItem(pendingDraftsKey(channelId), JSON.stringify(Object.fromEntries(pending)));
  } catch { /* Storage can be unavailable in restricted browser contexts. */ }
};

const clearPendingDraft = (channelId: string, id: string): void => {
  try {
    const pending = readPendingDrafts(channelId);
    pending.delete(id);
    if (pending.size === 0) window.sessionStorage.removeItem(pendingDraftsKey(channelId));
    else window.sessionStorage.setItem(pendingDraftsKey(channelId), JSON.stringify(Object.fromEntries(pending)));
  } catch { /* Storage can be unavailable in restricted browser contexts. */ }
};

export interface ChatVoteTemplateAutosave {
  draftFor: (template: ChatVoteTemplate) => ChatVoteTemplateDraft;
  stateFor: (template: ChatVoteTemplate) => TemplateSaveState;
  shortcutErrorFor: (template: ChatVoteTemplate) => string | null;
  change: (template: ChatVoteTemplate, update: Partial<ChatVoteTemplateDraft>) => void;
  markUsed: (templateId: string, openedAt: string) => void;
  templatesRefreshed: (templates: readonly ChatVoteTemplate[]) => void;
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
  const entriesRef = useRef(new Map<string, TemplateDraftEntry>());
  const dirtyRef = useRef(new Set<string>());
  const serverShortcutConflictsRef = useRef(new Map<string, string>());
  const timersRef = useRef(new Map<string, number>());
  const queuesRef = useRef(new Map<string, Promise<boolean>>());
  const [revision, setRevision] = useState(0);
  const [states, setStates] = useState(new Map<string, TemplateSaveState>());
  const [shortcutErrors, setShortcutErrors] = useState(new Map<string, string>());

  templatesRef.current = new Map(templates.map((template) => [template.id, template]));
  const ensureEntry = useCallback((template: ChatVoteTemplate): TemplateDraftEntry => {
    const current = entriesRef.current.get(template.id);
    if (current !== undefined) return current;
    const acknowledged = draftFrom(template);
    const entry = { baseRevision: template.revision, acknowledged, draft: acknowledged };
    entriesRef.current.set(template.id, entry);
    return entry;
  }, []);
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
    if (serverShortcutConflictsRef.current.get(id) === value) return labels.shortcutDuplicate;
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
    const entry = ensureEntry(template);
    const draft = entry.draft;
    const shortcutError = shortcutProblem(id, draft.shortcut);
    updateShortcutError(id, shortcutError);
    const safeDraft: ChatVoteTemplateDraft = {
      ...draft,
      shortcut: shortcutError === null ? draft.shortcut || null : template.shortcut,
    };
    if (sameDraft(safeDraft, entry.acknowledged)) {
      dirtyRef.current.delete(id);
      clearPendingDraft(channelId, id);
      updateState(id, "saved");
      setRevision((current) => current + 1);
      return true;
    }

    updateState(id, "saving");
    const applySaved = (saved: ChatVoteTemplate, sent: ChatVoteTemplateDraft): boolean => {
      updateTemplate(saved);
      const currentEntry = entriesRef.current.get(id) ?? {
        baseRevision: entry.baseRevision,
        acknowledged: entry.acknowledged,
        draft: sent,
      };
      const latestEntry = {
        baseRevision: saved.revision,
        acknowledged: draftFrom(saved),
        draft: currentEntry.draft,
      };
      entriesRef.current.set(id, latestEntry);
      const latestDraft = latestEntry.draft;
      const latestProblem = shortcutProblem(id, latestDraft.shortcut);
      const latestSafe: ChatVoteTemplateDraft = {
        ...latestDraft,
        shortcut: latestProblem === null ? latestDraft.shortcut || null : saved.shortcut,
      };
      const remainsDirty = !sameDraft(latestSafe, latestEntry.acknowledged);
      if (remainsDirty) dirtyRef.current.add(id);
      else dirtyRef.current.delete(id);
      if (remainsDirty || latestProblem !== null) writePendingDraft(channelId, id, latestEntry);
      else clearPendingDraft(channelId, id);
      updateState(id, remainsDirty ? "saving" : "saved");
      setRevision((current) => current + 1);
      return true;
    };

    try {
      const saved = await saveChatVoteTemplate(channelId, id, entry.baseRevision, safeDraft, keepalive);
      return applySaved(saved, safeDraft);
    } catch (error: unknown) {
      let saveError: unknown = error;
      if (saveError instanceof PanelApiError && saveError.code === "chat_vote_template_shortcut_conflict" && shortcutError === null) {
        if (safeDraft.shortcut !== null) {
          updateShortcutError(id, labels.shortcutDuplicate);
          serverShortcutConflictsRef.current.set(id, safeDraft.shortcut);
        }
        const fallback = { ...safeDraft, shortcut: template.shortcut };
        try {
          const saved = await saveChatVoteTemplate(channelId, id, entry.baseRevision, fallback, keepalive);
          return applySaved(saved, fallback);
        } catch (retryError: unknown) {
          saveError = retryError;
        }
      }
      if (saveError instanceof PanelApiError && saveError.status === 409 && saveError.code === "chat_vote_template_conflict") {
        try {
          const reloaded = await loadChatVoteTemplates(channelId);
          templatesRef.current = new Map(reloaded.templates.map((entry) => [entry.id, entry]));
          serverShortcutConflictsRef.current.clear();
          const latest = reloaded.templates.find((entry) => entry.id === id);
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
            const acknowledged = draftFrom(latest);
            entriesRef.current.set(id, { baseRevision: latest.revision, acknowledged, draft: acknowledged });
            dirtyRef.current.delete(id);
            clearPendingDraft(channelId, id);
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
  }, [channelId, ensureEntry, labels, shortcutProblem, updateShortcutError, updateState, updateTemplate]);

  const enqueue = useCallback((id: string, keepalive = false): Promise<boolean> => {
    const previous = queuesRef.current.get(id) ?? Promise.resolve(true);
    const next = previous.catch(() => false).then(() => saveOne(id, keepalive)).finally(() => {
      if (queuesRef.current.get(id) === next) queuesRef.current.delete(id);
    });
    queuesRef.current.set(id, next);
    return next;
  }, [saveOne]);

  const flush = useCallback(async (id: string, keepalive = false): Promise<boolean> => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    for (;;) {
      const pending = queuesRef.current.get(id);
      if (pending !== undefined) {
        if (keepalive) {
          const entry = entriesRef.current.get(id);
          if (entry !== undefined) writePendingDraft(channelId, id, entry);
          return false;
        }
        if (!await pending) return false;
      }
      const nextTimer = timersRef.current.get(id);
      if (nextTimer !== undefined) {
        window.clearTimeout(nextTimer);
        timersRef.current.delete(id);
      }
      if (!dirtyRef.current.has(id)) return true;
      if (!await enqueue(id, keepalive)) return false;
    }
  }, [channelId, enqueue]);

  const flushAll = useCallback(async (keepalive = false): Promise<boolean> => {
    const ids = [...new Set([...dirtyRef.current, ...queuesRef.current.keys()])];
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

  useEffect(() => {
    void primeChatVotingCsrfToken();
  }, []);

  const restoredDraftIds = useRef(new Set<string>());
  useEffect(() => {
    const pending = readPendingDrafts(channelId);
    const restoredErrors: Array<{ id: string; problem: string | null }> = [];
    const restoredDirtyIds: string[] = [];
    const revisionConflicts: Array<{ id: string; title: string }> = [];
    for (const template of templates) {
      if (restoredDraftIds.current.has(template.id)) continue;
      restoredDraftIds.current.add(template.id);
      const restored = pending.get(template.id);
      if (restored === undefined) continue;
      const acknowledged = draftFrom(template);
      if (restored.baseRevision !== template.revision || !sameDraft(restored.acknowledged, acknowledged)) {
        entriesRef.current.set(template.id, { baseRevision: template.revision, acknowledged, draft: acknowledged });
        dirtyRef.current.delete(template.id);
        clearPendingDraft(channelId, template.id);
        revisionConflicts.push({ id: template.id, title: template.title.trim() || labels.untitled });
        continue;
      }
      entriesRef.current.set(template.id, restored);
      const problem = shortcutProblem(template.id, restored.draft.shortcut);
      restoredErrors.push({ id: template.id, problem });
      const projected = { ...restored.draft, shortcut: problem === null ? restored.draft.shortcut || null : template.shortcut };
      if (!sameDraft(projected, acknowledged)) {
        dirtyRef.current.add(template.id);
        restoredDirtyIds.push(template.id);
      } else if (problem === null) {
        entriesRef.current.delete(template.id);
        clearPendingDraft(channelId, template.id);
      }
    }
    if (restoredErrors.length > 0 || revisionConflicts.length > 0) window.setTimeout(() => {
      for (const { id, problem } of restoredErrors) updateShortcutError(id, problem);
      for (const id of restoredDirtyIds) schedule(id);
      for (const { id, title } of revisionConflicts) {
        updateState(id, "conflict");
        notify({ tone: "error", message: labels.saveConflictToast(title) });
      }
      if (restoredDirtyIds.length > 0 || revisionConflicts.length > 0) setRevision((current) => current + 1);
    }, 0);
  }, [channelId, labels, schedule, shortcutProblem, templates, updateShortcutError, updateState]);

  const draftFor = useCallback((template: ChatVoteTemplate): ChatVoteTemplateDraft => {
    void revision;
    return ensureEntry(template).draft;
  }, [ensureEntry, revision]);
  const stateFor = useCallback((template: ChatVoteTemplate): TemplateSaveState => states.get(template.id) ?? "saved", [states]);
  const shortcutErrorFor = useCallback((template: ChatVoteTemplate): string | null => shortcutErrors.get(template.id) ?? null, [shortcutErrors]);
  const change = useCallback((template: ChatVoteTemplate, update: Partial<ChatVoteTemplateDraft>): void => {
    const entry = ensureEntry(template);
    const next = { ...entry.draft, ...update };
    if (Object.hasOwn(update, "shortcut") && next.shortcut !== entry.draft.shortcut) {
      serverShortcutConflictsRef.current.delete(template.id);
    }
    const latestTemplate = templatesRef.current.get(template.id) ?? template;
    const problem = shortcutProblem(template.id, next.shortcut);
    updateShortcutError(template.id, problem);
    const projected = { ...next, shortcut: problem === null ? next.shortcut || null : latestTemplate.shortcut };
    const updatedEntry = { ...entry, draft: next };
    entriesRef.current.set(template.id, updatedEntry);
    if (sameDraft(projected, entry.acknowledged)) dirtyRef.current.delete(template.id);
    else dirtyRef.current.add(template.id);
    writePendingDraft(channelId, template.id, updatedEntry);
    setRevision((currentRevision) => currentRevision + 1);
    schedule(template.id);
  }, [channelId, ensureEntry, schedule, shortcutProblem, updateShortcutError]);
  const templatesRefreshed = useCallback((refreshed: readonly ChatVoteTemplate[]): void => {
    templatesRef.current = new Map(refreshed.map((template) => [template.id, template]));
    serverShortcutConflictsRef.current.clear();
    for (const [id, currentEntry] of entriesRef.current) {
      const latestTemplate = templatesRef.current.get(id);
      let entry = currentEntry;
      if (latestTemplate !== undefined && !dirtyRef.current.has(id) && entry.baseRevision !== latestTemplate.revision) {
        const acknowledged = draftFrom(latestTemplate);
        entry = { baseRevision: latestTemplate.revision, acknowledged, draft: entry.draft };
        entriesRef.current.set(id, entry);
      }
      const problem = shortcutProblem(id, entry.draft.shortcut);
      updateShortcutError(id, problem);
      const projected = {
        ...entry.draft,
        shortcut: problem === null ? entry.draft.shortcut || null : latestTemplate?.shortcut ?? null,
      };
      if (sameDraft(projected, entry.acknowledged)) dirtyRef.current.delete(id);
      else {
        dirtyRef.current.add(id);
        schedule(id);
      }
    }
  }, [schedule, shortcutProblem, updateShortcutError]);
  const markUsed = useCallback((templateId: string, openedAt: string): void => {
    const current = templatesRef.current.get(templateId);
    if (current !== undefined) updateTemplate({ ...current, lastUsedAt: openedAt });
  }, [updateTemplate]);
  const reset = useCallback((template: ChatVoteTemplate): void => {
    const current = templatesRef.current.get(template.id) ?? template;
    const acknowledged = draftFrom(current);
    entriesRef.current.set(template.id, { baseRevision: current.revision, acknowledged, draft: acknowledged });
    dirtyRef.current.delete(template.id);
    clearPendingDraft(channelId, template.id);
    serverShortcutConflictsRef.current.delete(template.id);
    updateShortcutError(template.id, null);
    updateState(template.id, "saved");
    setRevision((currentRevision) => currentRevision + 1);
  }, [channelId, updateShortcutError, updateState]);
  const clear = useCallback((id: string): void => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timersRef.current.delete(id);
    entriesRef.current.delete(id);
    dirtyRef.current.delete(id);
    clearPendingDraft(channelId, id);
    serverShortcutConflictsRef.current.delete(id);
    updateShortcutError(id, null);
    setStates((current) => { const next = new Map(current); next.delete(id); return next; });
  }, [channelId, updateShortcutError]);

  useEffect(() => {
    const onPageHide = (): void => { void flushAll(true); };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      void flushAll(true);
    };
  }, [channelId, flushAll]);

  return { draftFor, stateFor, shortcutErrorFor, change, markUsed, templatesRefreshed, flush, flushAll, reset, clear };
};
