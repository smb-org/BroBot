import { Notification, Portal } from "@mantine/core";
import { useSyncExternalStore } from "react";

import { dashboardCommonTexts } from "../locale";
import { colors } from "./theme";
import { dismissToast, subscribeToToasts, toastsSnapshot } from "./toast-store";

/** The dashboard shell mounts this host once; modules call `notify` through the UI seam. */
export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToToasts, toastsSnapshot, toastsSnapshot);
  const closeLabel = dashboardCommonTexts().close;

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
            {toast.message}
          </Notification>
        ))}
      </div>
    </Portal>
  );
}
