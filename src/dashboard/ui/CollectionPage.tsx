import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { PageHeader } from "./PageHeader";

const SINGLE_COLUMN_MAX_INLINE_SIZE = 935;

const contentInlineSize = (element: HTMLElement): number => {
  const style = window.getComputedStyle(element);
  const borderAndPadding = [
    style.borderLeftWidth,
    style.borderRightWidth,
    style.paddingLeft,
    style.paddingRight,
  ].reduce((total, value) => total + (Number.parseFloat(value) || 0), 0);
  return element.getBoundingClientRect().width - borderAndPadding;
};

export interface CollectionPageProps {
  title: string;
  headingLevel?: "h1" | "h2" | "h3";
  headerKind?: string;
  subtitle?: ReactNode;
  toolbar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  empty?: ReactNode;
  detailOpen?: boolean;
  backLabel?: string;
  closeDetailDisabled?: boolean;
  onCloseDetail?: () => void;
}

export function CollectionPage({
  title,
  headingLevel = "h1",
  headerKind,
  subtitle,
  toolbar,
  list,
  detail,
  empty,
  detailOpen = false,
  backLabel,
  closeDetailDisabled = false,
  onCloseDetail,
}: CollectionPageProps): ReactElement {
  const texts = dashboardCommonTexts();
  const Heading = headingLevel;
  const collectionRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const previousLayout = useRef({ detailOpen, singleColumn: false });
  const returnFocus = useRef<HTMLElement | null>(null);
  const [singleColumn, setSingleColumn] = useState(false);

  useLayoutEffect(() => {
    const collection = collectionRef.current;
    const container = collection?.closest<HTMLElement>(".main-content");
    if (container === null || container === undefined) return;

    const updateLayout = (inlineSize: number): void => {
      const nextSingleColumn = inlineSize <= SINGLE_COLUMN_MAX_INLINE_SIZE;
      setSingleColumn((current) => current === nextSingleColumn ? current : nextSingleColumn);
    };

    const updateFromContainer = (): void => { updateLayout(contentInlineSize(container)); };
    updateFromContainer();
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) updateLayout(entry.contentRect.width);
    });
    window.addEventListener("resize", updateFromContainer);
    observer.observe(container);
    return () => {
      window.removeEventListener("resize", updateFromContainer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const previous = previousLayout.current;
    previousLayout.current = { detailOpen, singleColumn };
    const openedDetail = !previous.detailOpen && detailOpen;
    const closedDetail = previous.detailOpen && !detailOpen;
    const enteredSingleColumn = !previous.singleColumn && singleColumn;
    const active = document.activeElement;
    const focusIsInList = active instanceof HTMLElement && listRef.current?.contains(active) === true;

    if (singleColumn && (openedDetail || (enteredSingleColumn && focusIsInList))) {
      returnFocus.current = focusIsInList && active instanceof HTMLElement ? active : null;
      const frame = window.requestAnimationFrame(() => {
        if (document.activeElement !== active) return;
        const heading = detailRef.current?.querySelector<HTMLElement>("h1, h2, h3");
        if (heading === undefined || heading === null) return;
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
      });
      return () => { window.cancelAnimationFrame(frame); };
    }

    if (!closedDetail || (!singleColumn && !previous.singleColumn)) return;
    const frame = window.requestAnimationFrame(() => {
      const preferred = returnFocus.current;
      const fallback = listRef.current?.querySelector<HTMLElement>("[aria-selected='true'], [aria-current='true'], button");
      const target = preferred?.isConnected === true ? preferred : fallback;
      target?.focus();
      returnFocus.current = null;
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [detailOpen, singleColumn]);

  return (
    <div ref={collectionRef} data-ui="" className="collection-page" data-detail-open={detailOpen ? "true" : "false"} data-single-column={singleColumn ? "true" : "false"}>
      <div className={`collection-page__heading${subtitle === undefined ? "" : " collection-page__heading--page-header"}`}>
        {subtitle === undefined
          ? <header><Heading>{title}</Heading></header>
          : <PageHeader kind={headerKind ?? "module"} title={title} subtitle={subtitle} />}
      </div>
      <div className="collection-page__body">
        <aside ref={listRef} aria-label={`${title}: ${texts.chooseCollection}`} className="collection-page__list">
          <div className="collection-page__list-toolbar">{toolbar}</div>
          <div className="collection-page__list-content">
            {list ?? <div className="collection-page__empty">{empty ?? texts.noCollectionEntries}</div>}
          </div>
        </aside>
        <section
          ref={detailRef}
          aria-label={`${title}: ${texts.editSelection}`}
          className="collection-page__detail"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented || !detailOpen || onCloseDetail === undefined) return;
            event.preventDefault();
            onCloseDetail();
          }}
        >
          {onCloseDetail === undefined || backLabel === undefined ? null : <Button className="collection-page__detail-back" variant="neutral" disabled={closeDetailDisabled} onClick={onCloseDetail}><Icon name="collapse" size={16} />{backLabel}</Button>}
          {detail}
        </section>
      </div>
    </div>
  );
}
