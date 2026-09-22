export interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
  /** When this response arrived. Drives the data-age display. */
  loadedAt?: number;
}

export type LoadStateSetter<T> = (value: LoadState<T> | ((current: LoadState<T>) => LoadState<T>)) => void;

export const idleState = <T,>(): LoadState<T> => ({ status: "idle", data: null, error: null });

export const loadingState = <T,>(current?: LoadState<T>): LoadState<T> => {
  const next: LoadState<T> = { status: "loading", data: current?.data ?? null, error: null };
  if (current?.loadedAt !== undefined) next.loadedAt = current.loadedAt;
  return next;
};

export const loadedState = <T,>(data: T): LoadState<T> => ({ status: "success", data, error: null, loadedAt: Date.now() });
