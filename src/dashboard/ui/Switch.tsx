import { Switch as MantineSwitch } from "@mantine/core";

import { colors } from "./theme";

export interface SwitchProps {
  label?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** "trägt seinen Pending-Zustand selbst (`aria-busy`)" -- a switch is an
   *  immediate action, never behind a SaveBar. */
  pending?: boolean;
  /** "Für Bediener gesperrt, Sperrgrund als Navetikett darunter." Implies
   *  `disabled`; rendered as the 11px caption under the control. */
  lockedReason?: string;
}

/**
 * "Schalter": hit area 44x44, track 36x20 on Text-4, thumb 14px, on =
 * green track (docs/input/DESIGN-neu.md, "Bauteilvorgaben" and "Schalter").
 * Track/thumb radii differ (md / sm), so both are pinned in the theme's
 * `Switch` override rather than here.
 */
export function Switch({ label, checked, onChange, disabled, pending, lockedReason }: SwitchProps) {
  const isDisabled = disabled ?? Boolean(lockedReason);
  return (
    <div>
      <MantineSwitch
        label={label}
        labelPosition="left"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={isDisabled}
        aria-busy={pending}
        color={colors.green}
        styles={{ track: { backgroundColor: checked ? undefined : colors.text4 } }}
      />
      {lockedReason ? (
        <div style={{ fontSize: "11px", lineHeight: 1.1, color: colors.text3, marginTop: "4px" }}>{lockedReason}</div>
      ) : null}
    </div>
  );
}
