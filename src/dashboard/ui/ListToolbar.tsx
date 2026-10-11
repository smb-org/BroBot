import { useId, type KeyboardEvent, type ReactNode, type Ref } from "react";

import { formatNumber, type DashboardLanguage } from "../locale";
import { Button } from "./Button";
import { Field } from "./Field";
import { LoadState, type QueryError } from "./LoadState";

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
  language?: DashboardLanguage;
  searchLabel?: string;
  searchPlaceholder?: string;
  searchClearLabel?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
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
  queryError?: QueryError;
  activeFilters?: string;
  activeFiltersLabel?: string;
  resetLabel?: string;
  onReset?: () => void;
  className?: string;
}

const numberValue = (value: number, language?: DashboardLanguage) => <span className="mono">{formatNumber(value, language)}</span>;

const usageText = (usage: ListToolbarUsage, language?: DashboardLanguage): ReactNode => {
  const { copy } = usage;
  if (usage.maximum !== undefined) {
    return <>
      {usage.filteredCount === undefined ? null : <>{numberValue(usage.filteredCount, language)} {copy.filteredInfix} {numberValue(usage.count, language)} {copy.filteredSuffix} · </>}
      {numberValue(usage.count, language)} {copy.limitInfix} {numberValue(usage.maximum, language)} {copy.limitSuffix}
    </>;
  }
  if (usage.filteredCount !== undefined) {
    return <>{numberValue(usage.filteredCount, language)} {copy.filteredInfix} {numberValue(usage.count, language)} {copy.filteredSuffix}</>;
  }
  if (usage.loaded === true) return <>{numberValue(usage.count, language)} {copy.loadedSuffix}</>;
  return <>{numberValue(usage.count, language)} {copy.countSuffix}</>;
};

/** A fixed-height search/filter/action row with a permanently reserved status line. */
export function ListToolbar({
  language,
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
  queryError,
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
  const hasSearch = searchLabel !== undefined && searchPlaceholder !== undefined && searchClearLabel !== undefined &&
    searchValue !== undefined && onSearchChange !== undefined;

  return (
    <div className={["list-toolbar", className].filter(Boolean).join(" ")}>
      <div className={`list-toolbar__row${hasSearch ? "" : " list-toolbar__row--no-search"}`}>
        {hasSearch ? <div className="list-toolbar__search">
          <Field
            variant="search"
            label={searchLabel}
            placeholder={searchPlaceholder}
            clearLabel={searchClearLabel}
            value={searchValue}
            onChange={onSearchChange}
            {...(onSearchKeyDown === undefined ? {} : { onKeyDown: onSearchKeyDown })}
          />
        </div> : null}
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
      <LoadState
        variant="status-row"
        status={queryError === undefined ? "success" : "error"}
        loading={null}
        empty={null}
        error={null}
        {...(queryError === undefined ? {} : { queryError })}
        trailing={<div className="list-toolbar__status-right">
          {hasActiveFilters ? (
            <span className="list-toolbar__active-filters" title={`${activeFiltersLabel ?? ""} ${activeFilterText}`.trim()}>
              {activeFiltersLabel === undefined ? activeFilterText : `${activeFiltersLabel} ${activeFilterText}`}
            </span>
          ) : null}
          {createReason === undefined ? null : (
            <span id={createReasonId} className="list-toolbar__reason" role="note" title={createReason}>{createReason}</span>
          )}
          {hasActiveFilters && onReset !== undefined && resetLabel !== undefined ? (
            <button className="list-toolbar__reset" type="button" onClick={onReset}>{resetLabel}</button>
          ) : null}
        </div>}
        className="list-toolbar__status"
      >
        <>
          <span className={`list-toolbar__usage${warning ? " list-toolbar__usage--warning" : ""}`} aria-live="polite">
            {usage === undefined ? null : usageText(usage, language)}
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
        </>
      </LoadState>
    </div>
  );
}
