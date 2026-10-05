import type { ReactNode } from "react";

import { Button } from "./Button";
import { Icon } from "./Icon";
import { colors } from "./theme";

export interface SaveBarProps {
  dirty: boolean;
  pending?: boolean;
  error?: string;
  saved?: boolean;
  invalid?: boolean;
  invalidMessage?: string;
  invalidStatus?: ReactNode;
  persistent?: boolean;
  warnings?: readonly string[];
  warningStatusLabel?: (warnings: readonly string[], saved: boolean) => ReactNode;
  conflict?: { message: string; reloadLabel: string; onReload: () => void };
  footer?: ReactNode;
  destructive?: ReactNode;
  onSave: () => void;
  onInvalidSave?: () => void;
  onDiscard: () => void;
  saveLabel: string;
  discardLabel: string;
  savedLabel: string;
  pendingLabel: string;
  saveDescribedBy?: string;
  saveTitle?: string;
}

export function SaveBar({
  dirty,
  pending = false,
  error,
  saved = false,
  invalid = false,
  invalidMessage,
  invalidStatus,
  persistent = false,
  warnings = [],
  warningStatusLabel,
  conflict,
  footer,
  destructive,
  onSave,
  onInvalidSave,
  onDiscard,
  saveLabel,
  discardLabel,
  savedLabel,
  pendingLabel,
  saveDescribedBy,
  saveTitle,
}: SaveBarProps) {
  if (!persistent && !dirty && !saved) return null;

  const warningStatus = warnings.length === 0 ? null : warningStatusLabel?.(warnings, saved && !dirty) ?? warnings[0];
  const statusText = conflict !== undefined
    ? `× ${conflict.message}`
    : pending
      ? pendingLabel
      : error !== undefined
        ? `× ${error}`
        : saved && !dirty
          ? warningStatus ?? savedLabel
          : invalid && dirty
            ? invalidStatus ?? (invalidMessage === undefined ? "" : `× ${invalidMessage}`)
            : dirty
              ? warningStatus
              : null;
  const invalidAction = persistent && invalid && dirty && !pending && conflict === undefined;
  const saveDisabled = pending || conflict !== undefined || !dirty;
  const showButtons = dirty || persistent;

  return (
    <div className={`ui-save-bar${persistent ? " ui-save-bar--persistent" : ""}`} aria-busy={pending}>
      <div className="ui-save-bar__status" role="status" aria-live="polite">
        {warningStatus !== null && statusText === warningStatus || warningStatus !== null && saved && !dirty ? <Icon name="warning" size={16} /> : null}
        <div className="ui-save-bar__message" style={{ color: conflict !== undefined || error !== undefined || (invalid && dirty) ? colors.errorText : warningStatus !== null ? colors.amber : colors.text3 }}>
          {statusText}
        </div>
        {conflict === undefined ? null : <Button variant="neutral" icon="reload" onClick={conflict.onReload}>{conflict.reloadLabel}</Button>}
      </div>
      {footer === undefined || conflict !== undefined ? null : <div className="ui-save-bar__footer">{footer}</div>}
      {showButtons || destructive !== undefined ? (
        <div className={`ui-save-bar__actions${destructive === undefined ? "" : " ui-save-bar__actions--destructive"}`}>
          {destructive}
          <div className="ui-save-bar__buttons">
            {dirty && conflict === undefined ? <Button variant="subtle" onClick={onDiscard} disabled={pending}>{discardLabel}</Button> : null}
            {showButtons ? <Button
              variant={persistent && invalid ? "neutral" : "primary"}
              onClick={invalidAction && onInvalidSave !== undefined ? onInvalidSave : onSave}
              disabled={saveDisabled && !invalidAction}
              ariaDisabled={invalidAction}
              {...(saveDescribedBy === undefined ? {} : { describedBy: saveDescribedBy })}
              {...(saveTitle === undefined ? {} : { title: saveTitle })}
            >
              {saveLabel}
            </Button> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
