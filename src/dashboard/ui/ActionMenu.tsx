import { Menu } from "@mantine/core";
import { useId, useState } from "react";

import { Button, type ButtonSize } from "./Button";

export type ActionMenuItem =
  | { label: string; onSelect: () => void; disabled?: boolean; danger?: boolean }
  | { divider: true };

export function ActionMenu({ label, items, size = "compact" }: { label: string; items: readonly ActionMenuItem[]; size?: ButtonSize }) {
  const [opened, setOpened] = useState(false);
  const triggerId = useId();
  const dropdownId = useId();

  return <Menu opened={opened} onChange={setOpened} position="bottom-end" withinPortal>
    <Menu.Target>
      <Button id={triggerId} size={size} icon="more" iconOnly ariaLabel={label} ariaHasPopup="menu" ariaExpanded={opened} ariaControls={dropdownId} />
    </Menu.Target>
    <Menu.Dropdown id={dropdownId} aria-label={label} aria-labelledby={triggerId}>
      {items.map((item, index) => "divider" in item
        ? <Menu.Divider key={`divider-${String(index)}`} />
        : <Menu.Item
          key={item.label}
          disabled={item.disabled ?? false}
          {...(item.danger ? { className: "ui-action-menu__danger" } : {})}
          onClick={item.onSelect}
        >{item.label}</Menu.Item>)}
    </Menu.Dropdown>
  </Menu>;
}
