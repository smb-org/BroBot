import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { useId, useState } from "react";

import { Button, type ButtonSize } from "./Button";

export type ActionMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; description?: string }
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
              aria-label={item.label}
              disabled={item.disabled ?? false}
              {...(item.description === undefined ? {} : { "aria-describedby": `${dropdownId}-description-${String(index)}` })}
              className={item.danger ? "ui-action-menu__item ui-action-menu__danger" : "ui-action-menu__item"}
              onClick={item.onSelect}
            >
              <span className="ui-action-menu__item-label">{item.label}</span>
              {item.description === undefined ? null : <span id={`${dropdownId}-description-${String(index)}`} className="ui-action-menu__item-description">{item.description}</span>}
            </MenuPrimitive.Item>)}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  </MenuPrimitive.Root>;
}
