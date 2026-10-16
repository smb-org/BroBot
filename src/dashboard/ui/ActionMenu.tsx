import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useId, useState } from "react";

import { Button, type ButtonSize } from "./Button";

export type ActionMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; reason?: string }
  | { divider: true };

export function ActionMenu({ label, items, size = "compact" }: { label: string; items: readonly ActionMenuItem[]; size?: ButtonSize }) {
  const [opened, setOpened] = useState(false);
  const triggerId = useId();
  const dropdownId = useId();

  return <MenuPrimitive.Root open={opened} onOpenChange={setOpened}>
    <MenuPrimitive.Trigger render={<Button id={triggerId} size={size} icon="more" iconOnly ariaLabel={label} ariaHasPopup="menu" ariaExpanded={opened} ariaControls={dropdownId} />} />
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner side="bottom" align="end" sideOffset={4} className="z-[var(--layer-popover)]" style={{ zIndex: "var(--layer-popover)" }}>
        <MenuPrimitive.Popup data-ui="" id={dropdownId} aria-label={label} aria-labelledby={triggerId} className="ui-action-menu__dropdown">
          {items.map((item, index) => "divider" in item
            ? <MenuPrimitive.Separator data-ui="" className="ui-action-menu__divider" key={`divider-${String(index)}`} />
            : <MenuPrimitive.Item
              key={item.label}
              disabled={item.disabled ?? false}
              className={`${item.danger ? "ui-action-menu__danger " : ""}ui-action-menu__item${item.reason === undefined ? "" : " ui-action-menu__item--with-reason"}`}
              onClick={item.onSelect}
            ><span>{item.label}</span>{item.reason === undefined ? null : <small>{item.reason}</small>}</MenuPrimitive.Item>)}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root>;
}
