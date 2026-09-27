import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface ListDetailProps {
  /** The list. Always rendered, always first -- "Two children, list first"
   *  in docs/input/DESIGN-neu.md. */
  list: ReactNode;
  /** The selected row's (or the open create form's) inspector content, or
   *  a falsy value for no selection -- no second column, no drawer, no
   *  waiting dock. Pass a `SubInspector` from this seam: `ListDetail` only
   *  positions it, the inspector's own padding, border, radius, surface
   *  and named container come from there unchanged. */
  inspector: ReactNode;
  /** Fires from the floating inspector's backdrop click, below 1280px only --
   *  the desktop column has no backdrop. Escape and the inspector's own
   *  close button are the caller's concern (`SubInspector` already handles
   *  both); this is only the extra dismissal a floating surface needs. */
  onCloseInspector: () => void;
}

/**
 * "ListDetail" (docs/input/DESIGN-neu.md): the list and its selected row's
 * inspector, in exactly the shape the design document specifies -- from
 * 1280px a fixed 592px column beside the list; below that the inspector
 * floats from the right (up to 480px wide) instead of stacking under the
 * list. The responsive layout is one CSS switch in
 * `styles.css` (`.list-detail`/`.list-detail__inspector`). Below 1280px
 * the positioned inspector becomes a modal surface: the list is inert,
 * focus moves inside and stays there, and closing returns focus to the row
 * that opened it. At 1280px the inspector sits beside the list and both
 * columns remain available.
 *
 * Below 1280px, the backdrop and fixed inspector keep selection available
 * without changing the list width or making the page overflow.
 *
 * ponytail: the floating pair stays a normal DOM child of `.list-detail`
 * rather than a `createPortal` to `document.body`; `position: fixed` still
 * anchors to the real viewport as long as no ancestor between here and
 * `<body>` sets a transform/filter/perspective. None of `Shell`'s ancestors
 * do today. Upgrade path if one ever does: portal the backdrop and
 * inspector, not a redesign of the breakpoints above.
 */
export function ListDetail({ list, inspector, onCloseInspector }: ListDetailProps) {
  const open = Boolean(inspector);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth < 1280);
  const wasOpen = useRef(false);
  const wasNarrow = useRef(narrow);
  const listRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const modalBackground = useRef<Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }>>([]);

  useEffect(() => {
    const update = (): void => { setNarrow(window.innerWidth < 1280); };
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("resize", update); };
  }, []);

  useLayoutEffect(() => {
    const restoreBackground = (): void => {
      for (const state of modalBackground.current) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      modalBackground.current = [];
    };
    restoreBackground();
    if (!open || !narrow || rootRef.current === null) return;

    const states: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
    let branch: HTMLElement = rootRef.current;
    while (branch.parentElement !== null) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.classList.contains("list-detail__backdrop")) continue;
        states.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      branch = branch.parentElement;
    }
    modalBackground.current = states;
    return restoreBackground;
  }, [narrow, open]);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) returnFocus.current = active;
      if (narrow) inspectorRef.current?.querySelector<HTMLElement>(".inspector-close")?.focus();
      wasOpen.current = true;
      wasNarrow.current = narrow;
      return;
    }
    if (open && narrow && !wasNarrow.current) inspectorRef.current?.querySelector<HTMLElement>(".inspector-close")?.focus();
    if (!open && wasOpen.current) {
      wasOpen.current = false;
      const target = returnFocus.current;
      returnFocus.current = null;
      if (wasNarrow.current && target?.isConnected) target.focus();
    }
    wasNarrow.current = narrow;
  }, [narrow, open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!open || !narrow) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCloseInspector();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = [...(inspectorRef.current?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => element.getAttribute("aria-hidden") !== "true");
    const first = focusables[0];
    const last = focusables.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={rootRef} className={`list-detail${open ? " list-detail--open" : ""}`} onKeyDown={handleKeyDown}>
      <div
        ref={listRef}
        className="list-detail__list"
        inert={open && narrow}
        aria-hidden={open && narrow ? true : undefined}
        onFocusCapture={(event) => {
          if (event.target instanceof HTMLElement) returnFocus.current = event.target;
        }}
      >{list}</div>
      {open ? (
        <>
          <div className="list-detail__backdrop" aria-hidden="true" onClick={onCloseInspector} />
          <div
            ref={inspectorRef}
            className="list-detail__inspector"
            role={narrow ? "dialog" : undefined}
            aria-modal={narrow ? true : undefined}
            aria-label={narrow ? "Details" : undefined}
          >{inspector}</div>
        </>
      ) : null}
    </div>
  );
}
