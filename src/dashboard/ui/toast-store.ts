type ToastTone = "success" | "info" | "error";

export interface ToastInput {
  tone: ToastTone;
  message: string;
  scope?: string;
  action?: { label: string; onClick: () => void };
}

export interface ToastRecord extends Omit<ToastInput, "action"> {
  id: number;
  action?: { label: string; onClick: () => void };
}

const AUTO_DISMISS_MS = 4_000;
let nextToastId = 0;
let activeToasts: ToastRecord[] = [];
const listeners = new Set<() => void>();

const publish = (): void => {
  for (const listener of listeners) listener();
};

export const dismissToast = (id: number): void => {
  const next = activeToasts.filter((toast) => toast.id !== id);
  if (next.length === activeToasts.length) return;
  activeToasts = next;
  publish();
};

export const dismissToastsForScope = (scope: string): void => {
  const next = activeToasts.filter((toast) => toast.scope !== scope);
  if (next.length === activeToasts.length) return;
  activeToasts = next;
  publish();
};

export const subscribeToToasts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const toastsSnapshot = (): readonly ToastRecord[] => activeToasts;

/** Shows a dashboard toast. Success and info messages dismiss after four seconds. */
export const notify = ({ tone, message, scope, action }: ToastInput): number => {
  const id = ++nextToastId;
  activeToasts = [...activeToasts, { id, tone, message, ...(scope === undefined ? {} : { scope }), ...(action === undefined ? {} : { action }) }];
  publish();
  if (tone !== "error") window.setTimeout(() => { dismissToast(id); }, AUTO_DISMISS_MS);
  return id;
};
