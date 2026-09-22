import type { ReactNode } from "react";

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
  /** Fires from the floating form's backdrop click, below 1024px only --
   *  the desktop column has no backdrop. Escape and the inspector's own
   *  close button are the caller's concern (`SubInspector` already handles
   *  both); this is only the extra dismissal a floating surface needs. */
  onCloseInspector: () => void;
}

/**
 * "ListDetail" (docs/input/DESIGN-neu.md): the list and its selected row's
 * inspector, in exactly the shape the design document specifies -- from
 * 1024px a fixed 420px column beside the list; below that the inspector
 * floats from the right (480px, full width under 768px) instead of
 * stacking under the list. The three widths are one CSS switch in
 * `styles.css` (`.list-detail`/`.list-detail__inspector`), not a branch
 * here: the DOM stays a single tree and `position: fixed`/`sticky` do the
 * rest, so there's nothing to resync on resize and nothing that renders
 * differently between a real browser and this project's jsdom component
 * tests.
 *
 * The old, purely in-flow layout put the inspector below the list at
 * narrow widths; on the 1280px second monitor next to OBS -- narrower than
 * the old 1360px threshold this replaces -- that meant scrolling past the
 * whole list to ever see it. See "Why the boundary matters" in
 * docs/input/umbau-plan.md.
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
  return (
    <div className={`list-detail${open ? " list-detail--open" : ""}`}>
      <div className="list-detail__list">{list}</div>
      {open ? (
        <>
          <div className="list-detail__backdrop" aria-hidden="true" onClick={onCloseInspector} />
          <div className="list-detail__inspector">{inspector}</div>
        </>
      ) : null}
    </div>
  );
}
