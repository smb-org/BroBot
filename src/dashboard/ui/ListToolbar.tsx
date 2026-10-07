import { useId, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { formatNumber } from "../locale";
import { Button } from "./Button";
import { Field } from "./Field";

export interface ListToolbarUsage {
  count: number;
  maximum?: number;
  filteredCount?: number;
  loaded?: boolean;
  copy: {
    countSuffix: string;
    filteredInfix: string;
    filteredSuffix: string;
    limitInfix: string;
    limitSuffix: string;
    loadedSuffix: string;
  };
}

export interface ListToolbarProperties {
  searchLabel: string;
  searchPlaceholder: string;
  searchClearLabel: string;
  searchValue: string;
  onSearchChange: (value: string) => void;
  onSearchKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  filters?: ReactNode;
  filtersLabel?: string;
  create?: {
    label: string;
    onClick: () => void;
    ref?: Ref<HTMLButtonElement>;
    disabled?: boolean;
    reason?: string;
  };
  usage?: ListToolbarUsage;
  activeFilters?: string;
  activeFiltersLabel?: string;
  resetLabel?: string;
  onReset?: () => void;
  className?: string;
}

const numberValue = (value: number) => <span className="mono">{formatNumber(value)}</span>;

const usageText = (usage: ListToolbarUsage): ReactNode => {
  const { copy } = usage;
  if (usage.maximum !== undefined) {
    return <>
      {usage.filteredCount === undefined ? null : <>{numberValue(usage.filteredCount)} {copy.filteredInfix} {numberValue(usage.count)} {copy.filteredSuffix} · </>}
      {numberValue(usage.count)} {copy.limitInfix} {numberValue(usage.maximum)} {copy.limitSuffix}
    </>;
  }
  if (usage.filteredCount !== undefined) {
    return <>{numberValue(usage.filteredCount)} {copy.filteredInfix} {numberValue(usage.count)} {copy.filteredSuffix}</>;
  }
  if (usage.loaded === true) return <>{numberValue(usage.count)} {copy.loadedSuffix}</>;
  return <>{numberValue(usage.count)} {copy.countSuffix}</>;
};

/** A fixed-height search/filter/action row with a permanently reserved status line. */
export function ListToolbar({
  searchLabel,
  searchPlaceholder,
  searchClearLabel,
  searchValue,
  onSearchChange,
  onSearchKeyDown,
  filters,
  filtersLabel,
  create,
  usage,
  activeFilters,
  activeFiltersLabel,
  resetLabel,
  onReset,
  className,
}: ListToolbarProperties) {
  const createReasonId = useId();
  const createReason = create?.reason;
  const activeFilterText = activeFilters?.trim() ?? "";
  const hasActiveFilters = activeFilterText.length > 0;
  const warning = usage?.maximum !== undefined && usage.maximum > 0 && usage.count >= usage.maximum * 0.9;

  return (
    <div className={["list-toolbar", className].filter(Boolean).join(" ")}>
      <div className="list-toolbar__row">
        <div className="list-toolbar__search">
          <Field
            variant="search"
            label={searchLabel}
            placeholder={searchPlaceholder}
            clearLabel={searchClearLabel}
            value={searchValue}
            onChange={onSearchChange}
            {...(onSearchKeyDown === undefined ? {} : { onKeyDown: onSearchKeyDown })}
          />
        </div>
        {filters === undefined ? null : (
          <div className="list-toolbar__filters" role="group" aria-label={filtersLabel}>
            {filters}
          </div>
        )}
        {create === undefined ? null : (
          <div className="list-toolbar__create">
            <Button
              variant="primary"
              icon="add"
              {...(create.ref === undefined ? {} : { ref: create.ref })}
              disabled={create.disabled === true || createReason !== undefined}
              {...(createReason === undefined ? {} : { describedBy: createReasonId })}
              onClick={create.onClick}
            >{create.label}</Button>
          </div>
        )}
      </div>
      <div className="list-toolbar__status">
        <span className={`list-toolbar__usage${warning ? " list-toolbar__usage--warning" : ""}`} aria-live="polite">
          {usage === undefined ? null : usageText(usage)}
        </span>
        <div className="list-toolbar__status-right">
          {hasActiveFilters ? (
            <span className="list-toolbar__active-filters" title={`${activeFiltersLabel ?? ""} ${activeFilterText}`.trim()}>
              {activeFiltersLabel === undefined ? activeFilterText : `${activeFiltersLabel} ${activeFilterText}`}
            </span>
          ) : createReason === undefined ? null : (
            <span id={createReasonId} className="list-toolbar__reason" role="note" title={createReason}>{createReason}</span>
          )}
          {hasActiveFilters && onReset !== undefined && resetLabel !== undefined ? (
            <button className="list-toolbar__reset" type="button" onClick={onReset}>{resetLabel}</button>
          ) : null}
          {hasActiveFilters && createReason !== undefined ? (
            <span id={createReasonId} className="list-toolbar__reason" role="note" title={createReason}>{createReason}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
