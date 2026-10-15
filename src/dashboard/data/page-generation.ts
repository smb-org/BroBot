import { useCallback, useLayoutEffect, useRef } from "react";

/** A callback guard scoped to one mounted page generation. */
export const useMountedPageGuard = (): (() => boolean) => {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return useCallback(() => mounted.current, []);
};
