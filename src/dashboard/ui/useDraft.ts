import { useState } from "react";

export interface UseDraftResult<T> {
  value: T;
  setValue: (value: T | ((current: T) => T)) => void;
  /** Structural difference from the value this draft started from. */
  dirty: boolean;
  reset: () => void;
  /** Accepts a successful server value as the new clean baseline. */
  accept: (value: T) => void;
}

/**
 * "useDraft" (docs/input/DESIGN-neu.md): a local draft tracked against the
 * value it started from. `dirty` is a structural (JSON) comparison -- good
 * enough for the plain field records an inspector form edits, and it needs
 * no field-by-field bookkeeping. Selection changes start a fresh draft by
 * remounting the form with a `key` (as the existing command editor already
 * does), not by teaching this hook to track identity itself.
 */
export const useDraft = <T,>(initial: T, initiallyDirty = false): UseDraftResult<T> => {
  const [baseline, setBaseline] = useState(initial);
  const [value, setValue] = useState(initial);
  const [forcedDirty, setForcedDirty] = useState(initiallyDirty);
  const dirty = forcedDirty || JSON.stringify(value) !== JSON.stringify(baseline);
  const reset = (): void => { setValue(baseline); setForcedDirty(false); };
  const accept = (next: T): void => { setBaseline(next); setValue(next); setForcedDirty(false); };
  return { value, setValue, dirty, reset, accept };
};
