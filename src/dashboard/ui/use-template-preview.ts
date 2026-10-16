import { useEffect, useRef, useState } from "react";

interface UseTemplatePreviewOptions {
  text: string;
  refreshKey: number;
  requestKey?: string;
  enabled?: boolean;
  delayMilliseconds?: number;
  render: () => Promise<string>;
}

/** Refreshes server-expanded previews when their text or panel data changes. */
export const useTemplatePreview = ({
  text,
  refreshKey,
  requestKey,
  enabled = true,
  delayMilliseconds = 300,
  render,
}: UseTemplatePreviewOptions): { value: string | null; pending: boolean } => {
  const renderRef = useRef(render);
  const requestId = useRef(0);
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    renderRef.current = render;
  }, [render]);

  useEffect(() => {
    if (!enabled) {
      requestId.current += 1;
      return;
    }

    const currentRequestId = ++requestId.current;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && requestId.current === currentRequestId) setPending(true);
    });

    const timeout = window.setTimeout(() => {
      void Promise.resolve().then(() => renderRef.current()).then((value) => {
        if (cancelled || requestId.current !== currentRequestId) return;
        setValue(value);
        setPending(false);
      }).catch(() => {
        if (!cancelled && requestId.current === currentRequestId) {
          setValue(null);
          setPending(false);
        }
      });
    }, delayMilliseconds);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (requestId.current === currentRequestId) requestId.current += 1;
    };
  }, [delayMilliseconds, enabled, refreshKey, requestKey, text]);

  return {
    value: enabled ? value : null,
    pending: enabled && pending,
  };
};
