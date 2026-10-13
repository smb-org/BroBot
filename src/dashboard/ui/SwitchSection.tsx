import { useId, type ReactNode } from "react";

import { Switch as SwitchPrimitive } from "./primitives/switch";
import { LockedReason } from "./LockedReason";

export interface SwitchSectionProps {
  title: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint: string;
  children?: ReactNode;
  disabled?: boolean;
  pending?: boolean;
  lockedReason?: string;
  className?: string;
  id?: string;
}

export function SwitchSection({ title, checked, onChange, hint, children, disabled = false, pending = false, lockedReason, className, id }: SwitchSectionProps) {
  const generatedId = useId();
  const switchId = id ?? generatedId;
  const titleId = `${switchId}-title`;
  const detailId = `${switchId}-detail`;
  const blocked = disabled || pending || lockedReason !== undefined;
  const classes = ["ui-switch-section", className].filter(Boolean).join(" ");

  return <section data-ui="" className={classes} aria-labelledby={titleId} aria-busy={pending} data-checked={checked}>
    <header className="ui-switch-section__heading">
      <h2 id={titleId}>{title}</h2>
      <SwitchPrimitive id={switchId} aria-labelledby={titleId} aria-describedby={detailId} aria-busy={pending} checked={checked} disabled={blocked} onCheckedChange={(next) => { onChange(next); }} />
    </header>
    {checked ? <>
      {children === undefined ? null : <fieldset className="ui-switch-section__content" disabled={blocked}>{children}</fieldset>}
      <LockedReason id={detailId} {...(lockedReason === undefined ? {} : { reason: lockedReason })} />
    </> : lockedReason === undefined
      ? <p id={detailId} className="ui-switch-section__hint">{hint}</p>
      : <LockedReason id={detailId} reason={lockedReason} />}
  </section>;
}
