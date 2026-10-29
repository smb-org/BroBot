import { useState, type ReactElement, type ReactNode, type RefCallback } from "react";

import { Button } from "./Button";
import { SaveStatus } from "./SaveStatus";
import type { SaveStatusProps } from "./SaveStatus";
import { PopoverContent, PopoverPrimitive } from "./primitives/popover";

interface HeaderActionsProps {
  saveStatus?: ReactNode;
  save?: SaveStatusProps;
  saveTargetRef?: RefCallback<HTMLDivElement>;
  /** Keeps the empty save slot's row height so the header does not grow when the save cluster arrives. */
  reserveSave?: boolean;
  pageActions?: ReactNode;
  overflow?: ReactNode;
  moreActionsLabel: string;
}

export function HeaderActions({ saveStatus, save, saveTargetRef, reserveSave = false, pageActions, overflow, moreActionsLabel }: HeaderActionsProps): ReactElement {
  const [overflowOpen, setOverflowOpen] = useState(false);
  const hasOverflow = overflow !== undefined && overflow !== null && overflow !== false;

  return (
    <div className="page-header__right">
      {saveStatus === undefined || saveStatus === null
        ? save === undefined || (!save.persistent && !save.dirty && !save.saved) ? null : <div className="page-header__save"><SaveStatus {...save} /></div>
        : <div className="page-header__save">{saveStatus}</div>}
      {pageActions === undefined || pageActions === null ? null : <div className="page-header__page-actions page-header__actions">{pageActions}</div>}
      {saveTargetRef === undefined ? null : <div ref={saveTargetRef} className={`page-header__save page-header__save-target${reserveSave ? " page-header__save-target--reserved" : ""}`} />}
      {!hasOverflow ? null : (
        <PopoverPrimitive.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
          <PopoverPrimitive.Trigger render={<Button icon="more" iconOnly ariaLabel={moreActionsLabel} ariaExpanded={overflowOpen} ariaHasPopup="dialog" className="page-header__overflow-trigger" />} />
          <PopoverContent role="dialog" aria-label={moreActionsLabel} align="end" className="page-header__overflow" onClickCapture={() => { setOverflowOpen(false); }}>
            {overflow}
          </PopoverContent>
        </PopoverPrimitive.Root>
      )}
    </div>
  );
}
