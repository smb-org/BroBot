import { useEffect, useRef, useState } from "react";

interface PreviewState {
  cacheKey: string;
  value: string | null;
}

interface UseTemplatePreviewOptions {
  inputs: unknown;
  enabled?: boolean;
  delayMilliseconds?: number;
  render: () => Promise<string>;
}

const maximumCachedPreviews = 40;

/** Shares resolved previews while keeping each result tied to all expansion inputs. */
export const useTemplatePreview = ({
  inputs,
  enabled = true,
  delayMilliseconds = 300,
  render,
}: UseTemplatePreviewOptions): { value: string | null; pending: boolean } => {
  const cacheKey = JSON.stringify([inputs]);
  const renderRef = useRef(render);
  const cache = useRef(new Map<string, string>());
  const requestId = useRef(0);
  const [state, setState] = useState<PreviewState | null>(null);

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
    const cached = cache.current.get(cacheKey);
    if (cached !== undefined) {
      void Promise.resolve().then(() => {
        if (!cancelled && requestId.current === currentRequestId) {
          setState({ cacheKey, value: cached });
        }
      });
      return () => {
        cancelled = true;
        if (requestId.current === currentRequestId) requestId.current += 1;
      };
    }

    const timeout = window.setTimeout(() => {
      void Promise.resolve().then(() => renderRef.current()).then((value) => {
        if (cancelled || requestId.current !== currentRequestId) return;
        cache.current.set(cacheKey, value);
        while (cache.current.size > maximumCachedPreviews) {
          const oldestKey = cache.current.keys().next().value;
          if (oldestKey === undefined) break;
          cache.current.delete(oldestKey);
        }
        setState({ cacheKey, value });
      }).catch(() => {
        if (!cancelled && requestId.current === currentRequestId) {
          setState({ cacheKey, value: null });
        }
      });
    }, delayMilliseconds);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      if (requestId.current === currentRequestId) requestId.current += 1;
    };
  }, [cacheKey, delayMilliseconds, enabled]);

  const matchesKey = enabled && state?.cacheKey === cacheKey;
  return {
    // Keep the last resolved preview visible while a different key refreshes.
    value: enabled ? state?.value ?? null : null,
    pending: enabled && !matchesKey,
  };
};
