import { useCallback, useRef, useState, type RefCallback } from "react";

interface InspectorSelection<Key extends string> {
  selectedKey: Key | null;
  select: (key: Key) => void;
  rowRef: (key: Key) => RefCallback<HTMLTableRowElement>;
  close: () => void;
}

export const useInspectorSelection = <Key extends string>(): InspectorSelection<Key> => {
  const [selectedKey, setSelectedKey] = useState<Key | null>(null);
  const selectedKeyRef = useRef<Key | null>(null);
  const rowRefs = useRef(new Map<Key, HTMLTableRowElement>());

  const select = useCallback((key: Key): void => {
    selectedKeyRef.current = key;
    setSelectedKey(key);
  }, []);

  const rowRef = useCallback((key: Key): RefCallback<HTMLTableRowElement> => (row: HTMLTableRowElement | null): void => {
    if (row === null) {
      rowRefs.current.delete(key);
    } else {
      rowRefs.current.set(key, row);
    }
  }, []);

  const close = useCallback((): void => {
    const key = selectedKeyRef.current;
    selectedKeyRef.current = null;
    setSelectedKey(null);
    if (key !== null) rowRefs.current.get(key)?.focus();
  }, []);

  return { selectedKey, select, rowRef, close };
};
