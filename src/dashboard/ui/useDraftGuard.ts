import { useCallback, useEffect, useRef, useState } from "react";

export interface UseDraftGuardResult {
  /** Whether the three-way confirmation is open. */
  confirmOpen: boolean;
  /** The error from the last failed `saveAndSwitch`, if any. */
  saveError: string | undefined;
  /** Whether a save started by `saveAndSwitch` is still in flight. */
  saving: boolean;
  /** Runs `proceed` right away if the draft isn't dirty; otherwise holds it
   *  behind the confirmation until one of the three actions below resolves. */
  guardSwitch: (proceed: () => void, cancel?: () => void) => void;
  continueEditing: () => void;
  discardAndSwitch: () => void;
  saveAndSwitch: () => Promise<void>;
  /** For a save started by `saveAndSwitch`: completes the held navigation right now (call it in the
   *  step that commits the save). Returns false if there is nothing to complete. */
  completeSwitch: () => boolean;
}

/**
 * "Unsaved changes (useDraftGuard)" (docs/input/DESIGN-neu.md):
 * while the draft is dirty, switching the selection stays blocked behind a
 * three-way confirmation -- continue editing, discard and switch, save and
 * switch. A failed save keeps the switch blocked; the caller decides what
 * "switch" means (select another row, close the inspector, change channel)
 * by what it passes to `guardSwitch`.
 */
export const useDraftGuard = (
  dirty: boolean,
  onSave: () => Promise<string | null>,
  onDiscard: () => void,
): UseDraftGuardResult => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ proceed: () => void; cancel?: () => void } | null>(null);

  useEffect(() => {
    if (!dirty) return;
    const preventUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      Reflect.set(event, "returnValue", "");
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => { window.removeEventListener("beforeunload", preventUnload); };
  }, [dirty]);

  const guardSwitch = useCallback((proceed: () => void, cancel?: () => void): void => {
    if (!dirty) {
      proceed();
      return;
    }
    pending.current = { proceed, ...(cancel === undefined ? {} : { cancel }) };
    setSaveError(undefined);
    setConfirmOpen(true);
  }, [dirty]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current = null;
    };
  }, []);
  const switching = useRef(false);

  const resolve = useCallback((): void => {
    if (!mounted.current) return;
    const pendingNavigation = pending.current;
    pending.current = null;
    setConfirmOpen(false);
    pendingNavigation?.proceed();
  }, []);

  const completeSwitch = useCallback((): boolean => {
    if (!mounted.current || !switching.current || pending.current === null) return false;
    switching.current = false;
    resolve();
    return true;
  }, [resolve]);

  const continueEditing = useCallback((): void => {
    const pendingNavigation = pending.current;
    pending.current = null;
    setConfirmOpen(false);
    pendingNavigation?.cancel?.();
  }, []);

  const discardAndSwitch = useCallback((): void => {
    onDiscard();
    resolve();
  }, [onDiscard, resolve]);

  const saveAndSwitch = useCallback(async (): Promise<void> => {
    setSaving(true);
    setSaveError(undefined);
    switching.current = true;
    try {
      const error = await onSave();
      // An unmounted guard belongs to an obsolete editor: it must not navigate after the await.
      if (!mounted.current) return;
      if (error !== null) {
        setSaveError(error);
        return;
      }
      resolve();
    } finally {
      switching.current = false;
      setSaving(false);
    }
  }, [onSave, resolve]);

  return { confirmOpen, saveError, saving, guardSwitch, continueEditing, discardAndSwitch, saveAndSwitch, completeSwitch };
};
