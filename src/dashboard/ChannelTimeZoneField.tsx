import { useState, type ReactElement } from "react";

import { validChannelTimeZone } from "../modules/contract";
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
const timeZoneOptions: SelectOption[] = [
  { value: "UTC", label: "UTC" },
  ...supportedTimeZones.filter((timeZone) => timeZone !== "UTC").map((timeZone) => ({ value: timeZone, label: timeZone })),
];
const timeZoneValues = new Set(timeZoneOptions.map((option) => option.value));

export const ChannelTimeZoneField = ({ label, hint, value, onChange, canEdit, disabled }: ChannelTimeZoneFieldProperties): ReactElement => {
  const [search, setSearch] = useState("");
  const trimmedSearch = search.trim();
  const customValueOption: SelectOption | null = value.length > 0 && !timeZoneValues.has(value)
    ? { value, label: value }
    : null;
  const proposedOption: SelectOption | null = trimmedSearch.length > 0
    && trimmedSearch !== value
    && !timeZoneValues.has(trimmedSearch)
    && validChannelTimeZone(trimmedSearch)
    ? { value: trimmedSearch, label: `Use '${trimmedSearch}'` }
    : null;
  const options = [proposedOption, customValueOption, ...timeZoneOptions]
    .filter((option): option is SelectOption => option !== null);

  return <Select
    label={label}
    hint={hint}
    value={value.length > 0 ? value : null}
    onChange={(next) => {
      setSearch("");
      if (next !== null) onChange(next);
    }}
    options={options}
    searchable
    searchValue={search}
    onSearchChange={setSearch}
    disabled={disabled || !canEdit}
  />;
};
