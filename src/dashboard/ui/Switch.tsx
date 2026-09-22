import { Switch as MantineSwitch } from "@mantine/core";

import { colors } from "./theme";

export interface SwitchProps {
  label?: string;
  /** Accessible name when the switch carries no visible `label` -- e.g. a
   *  list row where the row itself already shows the subject's name and a
   *  second visible label next to the switch would repeat it. Ignored once
   *  `label` is set, same convention as `Select`'s `ariaLabel`. */
  ariaLabel?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** "Carries its own pending state (`aria-busy`)" -- a switch is an
   *  immediate action, never behind a SaveBar. */
  pending?: boolean;
  /** "Locked for operators, lock reason as a caption below it." Implies
   *  `disabled`; rendered as the 11px caption under the control. */
  lockedReason?: string;
}

/**
 * "Schalter": hit area 44x44, track 36x20 on Text-4, thumb 14px, on =
 * green track (docs/input/DESIGN-neu.md, "Bauteilvorgaben" and "Schalter").
 * Track/thumb radii differ (md / sm), so both are pinned in the theme's
 * `Switch` override rather than here.
 */
export function Switch({ label, ariaLabel, checked, onChange, disabled, pending, lockedReason }: SwitchProps) {
  // `pending` must disable the control, not just show `aria-busy`: without
  // this, a second click before the first request resolves fires another
  // `onChange` with the opposite value -- two in-flight PATCHes racing.
  const isDisabled = disabled ?? (Boolean(lockedReason) || Boolean(pending));
  return (
    <div>
      <MantineSwitch
        label={label}
        aria-label={label ? undefined : ariaLabel}
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
