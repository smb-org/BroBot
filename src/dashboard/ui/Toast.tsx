import { Notification, Portal } from "@mantine/core";
import { useSyncExternalStore } from "react";

import { dashboardCommonTexts } from "../locale";
import { colors } from "./theme";
import { Button } from "./Button";
import { dismissToast, subscribeToToasts, toastsSnapshot } from "./toast-store";

/** The dashboard shell mounts this host once; modules call `notify` through the UI seam. */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToToasts, toastsSnapshot, toastsSnapshot);
  const closeLabel = dashboardCommonTexts().dismissNotification;

  return (
    <Portal>
      <div className="ui-toast-host">
        {toasts.map((toast) => (
          <Notification
            key={toast.id}
            className={`ui-toast ui-toast--${toast.tone}`}
            role={toast.tone === "error" ? "alert" : "status"}
            aria-live={toast.tone === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            color={toast.tone === "success" ? colors.green : toast.tone === "info" ? colors.text2 : colors.error}
            withBorder
            closeButtonProps={{ "aria-label": closeLabel }}
            onClose={() => { dismissToast(toast.id); }}
          >
            <span className="ui-toast__message">{toast.message}</span>
            {toast.action === undefined ? null : <Button size="compact" variant="subtle" onClick={() => {
              toast.action?.onClick();
              dismissToast(toast.id);
            }}>{toast.action.label}</Button>}
          </Notification>
        ))}
      </div>
    </Portal>
  );
}
