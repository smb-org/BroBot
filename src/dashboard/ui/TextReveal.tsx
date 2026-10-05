import { Popover as MantinePopover } from "@mantine/core";
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
  const popupId = useId();
  const common = dashboardCommonTexts();

  return (
    <span className={["ui-text-reveal", className].filter(Boolean).join(" ")}>
      <span className="ui-text-reveal__copy">{text}</span>
      <MantinePopover
        id={popupId}
        opened={open}
        onChange={setOpen}
        withinPortal
        position="top-start"
        width="max-content"
        middlewares={{ flip: true, shift: true }}
        shadow="xs"
        closeOnEscape
        hideDetached={false}
      >
        <MantinePopover.Target>
          <button
            className="ui-text-reveal__trigger"
            type="button"
            aria-label={open ? common.hideFullText : common.showFullText}
            {...(open ? { "aria-describedby": `${popupId}-dropdown` } : {})}
            onClick={() => { setOpen((current) => !current); }}
          >
            <Icon name="cause" size={16} />
          </button>
        </MantinePopover.Target>
        <MantinePopover.Dropdown className="ui-text-reveal__popup" role="tooltip">
          {text}
        </MantinePopover.Dropdown>
      </MantinePopover>
    </span>
  );
}
