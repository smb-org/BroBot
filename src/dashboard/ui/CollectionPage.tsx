import { useEffect, useRef, type ReactElement, type ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";
import { Button } from "./Button";

export interface CollectionPageProps {
  title: string;
  headingLevel?: "h1" | "h2" | "h3";
  toolbar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  empty?: ReactNode;
  detailOpen?: boolean;
  backLabel?: string;
  onCloseDetail?: () => void;
}

export function CollectionPage({
  title,
  headingLevel = "h1",
  toolbar,
  list,
  detail,
  empty,
  detailOpen = false,
  backLabel,
  onCloseDetail,
}: CollectionPageProps): ReactElement {
  const texts = dashboardCommonTexts();
  const Heading = headingLevel;
  const detailRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const previousDetailOpen = useRef(detailOpen);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const wasOpen = previousDetailOpen.current;
    previousDetailOpen.current = detailOpen;
    if (!window.matchMedia("(max-width: 768px)").matches || wasOpen === detailOpen) return;

    if (detailOpen) {
      const active = document.activeElement;
      returnFocus.current = active instanceof HTMLElement ? active : null;
      const frame = window.requestAnimationFrame(() => {
        if (document.activeElement !== active) return;
        const heading = detailRef.current?.querySelector<HTMLElement>("h1, h2, h3");
        if (heading === undefined || heading === null) return;
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.focus();
      });
      return () => { window.cancelAnimationFrame(frame); };
    }

    const frame = window.requestAnimationFrame(() => {
      const preferred = returnFocus.current;
      const fallback = listRef.current?.querySelector<HTMLElement>("[aria-selected='true'], [aria-current='true'], button");
      const target = preferred?.isConnected === true ? preferred : fallback;
      target?.focus();
      returnFocus.current = null;
    });
    return () => { window.cancelAnimationFrame(frame); };
  }, [detailOpen]);

  return (
    <div data-ui="" className="collection-page" data-detail-open={detailOpen ? "true" : "false"}>
      <header className="collection-page__heading"><Heading>{title}</Heading></header>
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
          {onCloseDetail === undefined || backLabel === undefined ? null : <Button className="collection-page__detail-back" variant="subtle" onClick={onCloseDetail}>{backLabel}</Button>}
          {detail}
        </section>
      </div>
    </div>
  );
}
