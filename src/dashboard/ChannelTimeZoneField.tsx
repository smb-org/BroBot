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
// `supportedValuesOf` omits UTC, so it is added once here; the final list
// (not the raw `supportedValuesOf` output) is what later dedupe checks run against.
const timeZoneOptions: SelectOption[] = [
  { value: "UTC", label: "UTC" },
  ...supportedTimeZones.filter((timeZone) => timeZone !== "UTC").map((timeZone) => ({ value: timeZone, label: timeZone })),
];
const timeZoneValues = new Set(timeZoneOptions.map((option) => option.value));

export const ChannelTimeZoneField = ({ label, hint, value, onChange, canEdit, disabled }: ChannelTimeZoneFieldProperties): ReactElement => {
  const [search, setSearch] = useState("");
  const trimmedSearch = search.trim();
  // The saved value may be a zone outside `supportedValuesOf` (e.g. a custom
  // identifier entered before, or restored from the server) -- keep it selectable.
  const customValueOption: SelectOption | null = value.length > 0 && !timeZoneValues.has(value)
    ? { value, label: value }
    : null;
  // While typing a zone identifier the server would accept (validated the same
  // way `validChannelTimeZone` validates it server-side) but that isn't in the
  // canonical list, offer it as a selectable "Use '<typed>'" entry.
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
    onChange={(next) => { if (next !== null) onChange(next); }}
    options={options}
    searchable
    searchValue={search}
    onSearchChange={setSearch}
    disabled={disabled || !canEdit}
  />;
};
