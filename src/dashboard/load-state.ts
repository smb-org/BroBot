export interface LoadState<T> {
  status: "idle" | "loading" | "success" | "error";
  data: T | null;
  error: string | null;
  /** When this response arrived. Drives the data-age display. */
  loadedAt?: number;
}

export const loadingState = <T,>(current?: LoadState<T>): LoadState<T> => {
  const next: LoadState<T> = { status: "loading", data: current?.data ?? null, error: null };
  if (current?.loadedAt !== undefined) next.loadedAt = current.loadedAt;
  return next;
};
