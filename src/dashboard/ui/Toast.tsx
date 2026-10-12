import { createPortal } from "react-dom";
import { useSyncExternalStore } from "react";

import { dashboardCommonTexts } from "../locale";
import { Button } from "./Button";
import { dismissToast, subscribeToToasts, toastsSnapshot } from "./toast-store";

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToToasts, toastsSnapshot, toastsSnapshot);
  const closeLabel = dashboardCommonTexts().dismissNotification;

  return createPortal(<div data-ui="" className="ui-toast-host" aria-label={closeLabel}>
    {toasts.map((toast) => <div
      key={toast.id}
      data-ui=""
      className={`ui-toast ui-toast--${toast.tone}`}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <span className="ui-toast__message">{toast.message}</span>
      {toast.action === undefined ? null : <Button size="compact" variant="subtle" onClick={() => {
        toast.action?.onClick();
        dismissToast(toast.id);
      }}>{toast.action.label}</Button>}
      <Button size="compact" variant="subtle" icon="close" iconOnly ariaLabel={closeLabel} onClick={() => { dismissToast(toast.id); }} />
    </div>)}
  </div>, document.body);
}
