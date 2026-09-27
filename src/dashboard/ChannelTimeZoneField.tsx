import type { ReactElement } from "react";

import { Select, type SelectOption } from "./ui";

interface ChannelTimeZoneFieldProperties {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
  disabled: boolean;
}

const supportedTimeZones = typeof Intl.supportedValuesOf === "function"
  ? Intl.supportedValuesOf("timeZone")
  : [];
const supportedTimeZoneSet = new Set(supportedTimeZones);
const timeZoneOptions: SelectOption[] = [
  { value: "UTC", label: "UTC" },
  ...supportedTimeZones.filter((timeZone) => timeZone !== "UTC").map((timeZone) => ({ value: timeZone, label: timeZone })),
];

export const ChannelTimeZoneField = ({ label, hint, value, onChange, canEdit, disabled }: ChannelTimeZoneFieldProperties): ReactElement => {
  const options = value.length > 0 && !supportedTimeZoneSet.has(value)
    ? [{ value, label: value }, ...timeZoneOptions]
    : timeZoneOptions;
  return <Select
    label={label}
    hint={hint}
    value={value.length > 0 ? value : null}
    onChange={(next) => { if (next !== null) onChange(next); }}
    options={options}
    searchable
    disabled={disabled || !canEdit}
  />;
};
