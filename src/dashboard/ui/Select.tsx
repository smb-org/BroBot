import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useDisabledFieldReason } from "./DisabledFieldReason";
import { TruncatedText } from "./TruncatedText";
import { SelectContent, SelectGroup, SelectItem, SelectLabel, SelectPrimitive, SelectTrigger, SelectValue } from "./primitives/select";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
}

export interface SelectProps {
  label?: string;
  ariaLabel?: string;
  hint?: string;
  error?: string;
  value: string | null;
  onChange: (value: string | null) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  busy?: boolean;
  searchable?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  required?: boolean;
  name?: string;
  id?: string;
  title?: string;
  describedBy?: string;
}

const optionContents = (option: SelectOption): ReactNode => (
  <span className="ui-select__option">
    <span className="ui-select__option-label">{option.label}</span>
    {option.description === undefined ? null : <span className="ui-select__option-description">{option.description}</span>}
  </span>
);

export function Select({ label, ariaLabel, hint, error, value, onChange, options, placeholder, disabled = false, compact = false, busy = false, searchable = false, searchValue, onSearchChange, required = false, name, id, title, describedBy }: SelectProps) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [internalSearch, setInternalSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const disabledReason = useDisabledFieldReason();
  const activeSearch = searchValue ?? internalSearch;
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value ?? "";
  const selectItems = Object.fromEntries(options.map((option) => [option.value, option.label]));
  const displaySearch = activeSearch.length > 0 ? activeSearch : selectedLabel;
  const updateSearch = (next: string): void => {
    setInternalSearch(next);
    onSearchChange?.(next);
  };
  const clearSearch = (): void => updateSearch("");
  const descriptionId = `${controlId}-description`;
  const errorId = `${controlId}-error`;
  const describedByIds = [describedBy, hint === undefined ? null : descriptionId, error === undefined ? null : errorId, disabledReason?.id].filter((part): part is string => part !== null && part !== undefined).join(" ") || undefined;
  const groups = [...new Set(options.flatMap((option) => option.group === undefined ? [] : [option.group]))];
  const group = (groupName: string): ReactNode => (
    <SelectGroup key={groupName}>
      <SelectLabel>{groupName}</SelectLabel>
      {options.filter((option) => option.group === groupName).map((option) => <SelectItem key={option.value} value={option.value}>{optionContents(option)}</SelectItem>)}
    </SelectGroup>
  );

  return <div data-ui="" className={`ui-select${compact ? " ui-select--compact" : ""}`}>
    {label === undefined ? null : <label className="ui-field__label" htmlFor={controlId}>{label}</label>}
    {searchable ? <Combobox.Root
      autoHighlight
      data-ui=""
      open={searchOpen}
      onOpenChange={(next) => {
        setSearchOpen(next);
        if (!next) clearSearch();
      }}
      items={options.map((option) => option.value)}
      itemToStringLabel={(optionValue) => options.find((option) => option.value === optionValue)?.label ?? optionValue}
      filteredItems={options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes(activeSearch.trim().toLocaleLowerCase())).map((option) => option.value)}
      filter={null}
      value={value ?? ""}
      onValueChange={(next) => {
        onChange(next === null || next.length === 0 ? null : next);
        setSearchOpen(false);
        clearSearch();
      }}
      inputValue={displaySearch}
      onInputValueChange={(next) => {
        updateSearch(next === selectedLabel ? "" : next);
        if (next.length > 0) setSearchOpen(true);
      }}
      disabled={disabled}
      name={name}
      required={required}
    >
      <div className="ui-select__search-control">
        <Combobox.Input id={controlId} aria-label={label === undefined ? ariaLabel : undefined} aria-describedby={describedByIds} aria-busy={busy} title={title} placeholder={placeholder} disabled={disabled} onClick={() => { if (!disabled) setSearchOpen(true); }} className="ui-select__search-input" />
        <Combobox.Trigger aria-label={ariaLabel ?? label} className="ui-select__trigger"><ChevronDown aria-hidden="true" size={16} /></Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner align="start" sideOffset={4} className="z-50">
          <Combobox.Popup data-ui="" className="ui-select__dropdown">
            <Combobox.List className="ui-select__options" aria-label={label ?? ariaLabel}>
              {options.filter((option) => option.group === undefined).map((option) => <Combobox.Item key={option.value} value={option.value} className="ui-select__combobox-option">{optionContents(option)}<Combobox.ItemIndicator className="ui-select__check"><Check aria-hidden="true" size={14} /></Combobox.ItemIndicator></Combobox.Item>)}
              {groups.map((groupName) => <div role="group" aria-label={groupName} key={groupName}>
                <div className="ui-select__group-label">{groupName}</div>
                {options.filter((option) => option.group === groupName).map((option) => <Combobox.Item key={option.value} value={option.value} className="ui-select__combobox-option">{optionContents(option)}<Combobox.ItemIndicator className="ui-select__check"><Check aria-hidden="true" size={14} /></Combobox.ItemIndicator></Combobox.Item>)}
              </div>)}
              {options.filter((option) => `${option.label} ${option.value}`.toLocaleLowerCase().includes((searchValue ?? "").trim().toLocaleLowerCase())).length === 0 ? <div className="ui-select__empty" role="status">{placeholder}</div> : null}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root> : <SelectPrimitive.Root items={selectItems} value={value} onValueChange={(next) => onChange(next)} disabled={disabled} name={name} required={required}>
      <SelectTrigger id={controlId} aria-label={label === undefined ? ariaLabel : undefined} aria-describedby={describedByIds} aria-busy={busy} title={title} className="ui-select__trigger">
        <SelectValue placeholder={placeholder} className="ui-select__value" />
      </SelectTrigger>
      <SelectContent className="ui-select__dropdown">
        {options.filter((option) => option.group === undefined).map((option) => <SelectItem key={option.value} value={option.value}>{optionContents(option)}</SelectItem>)}
        {groups.map(group)}
      </SelectContent>
    </SelectPrimitive.Root>}
    {compact ? null : <span data-ui="" id={descriptionId} className="ui-select__description">{hint === undefined ? null : <TruncatedText text={hint} />}{disabledReason === null ? null : <span className="sr-only">{disabledReason.reason}</span>}</span>}
    {compact || error === undefined ? null : <span data-ui="" id={errorId} className="ui-select__error" role="alert"><span aria-hidden="true">× </span><TruncatedText text={error} /></span>}
  </div>;
}
