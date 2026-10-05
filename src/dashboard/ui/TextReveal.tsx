import { useId, useState } from "react";

import { dashboardCommonTexts } from "../locale";
import { Icon } from "./Icon";

export interface TextRevealProps {
  text: string;
  className?: string;
}

/** One-line copy with a keyboard-operable disclosure for the complete text. */
export function TextReveal({ text, className }: TextRevealProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const common = dashboardCommonTexts();

  return (
    <span className={["ui-text-reveal", className].filter(Boolean).join(" ")}>
      <span className="ui-text-reveal__copy" title={text}>{text}</span>
      <button
        className="ui-text-reveal__trigger"
        type="button"
        aria-label={open ? common.hideFullText : common.showFullText}
        aria-expanded={open}
        {...(open ? { "aria-describedby": tooltipId } : {})}
        title={text}
        onClick={() => { setOpen((current) => !current); }}
      >
        <Icon name="cause" size={16} />
      </button>
      {open ? <span className="ui-text-reveal__popup" id={tooltipId} role="tooltip">{text}</span> : null}
    </span>
  );
}
