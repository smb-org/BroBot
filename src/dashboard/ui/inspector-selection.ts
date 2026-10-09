import { useCallback, useRef, useState, type RefCallback } from "react";

interface InspectorSelection<Key extends string> {
  selectedKey: Key | null;
  select: (key: Key) => void;
  rowRef: (key: Key) => RefCallback<HTMLElement>;
  close: () => void;
}

export const useInspectorSelection = <Key extends string>(identity: unknown = null): InspectorSelection<Key> => {
  const [selection, setSelection] = useState<{ identity: unknown; key: Key | null }>(() => ({ identity, key: null }));
  if (!Object.is(selection.identity, identity)) setSelection({ identity, key: null });
  const selectedKey = Object.is(selection.identity, identity) ? selection.key : null;
  const rowRefs = useRef(new Map<Key, HTMLElement>());

  const select = useCallback((key: Key): void => {
    setSelection({ identity, key });
  }, [identity]);

  const rowRef = useCallback((key: Key): RefCallback<HTMLElement> => (row: HTMLElement | null): void => {
    if (row === null) {
      rowRefs.current.delete(key);
    } else {
      rowRefs.current.set(key, row);
    }
  }, []);

  const close = useCallback((): void => {
    const key = selectedKey;
    setSelection({ identity, key: null });
    if (key !== null) rowRefs.current.get(key)?.focus();
  }, [identity, selectedKey]);

  return { selectedKey, select, rowRef, close };
};
