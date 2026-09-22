import { useState } from "react";

export interface UseDraftResult<T> {
  value: T;
  setValue: (value: T | ((current: T) => T)) => void;
  /** Structural difference from the value this draft started from. */
  dirty: boolean;
  reset: () => void;
}

/**
 * "useDraft" (docs/input/DESIGN-neu.md): a local draft tracked against the
 * value it started from. `dirty` is a structural (JSON) comparison -- good
 * enough for the plain field records an inspector form edits, and it needs
 * no field-by-field bookkeeping. Selection changes start a fresh draft by
 * remounting the form with a `key` (as the existing command editor already
 * does), not by teaching this hook to track identity itself.
 */
export const useDraft = <T,>(initial: T): UseDraftResult<T> => {
  const [value, setValue] = useState(initial);
  const dirty = JSON.stringify(value) !== JSON.stringify(initial);
  const reset = (): void => { setValue(initial); };
  return { value, setValue, dirty, reset };
};
