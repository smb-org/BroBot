import type { ReactNode } from "react";

export interface ListRowProps {
  href: string;
  onNavigate: () => void;
  icon?: ReactNode;
  title: string;
  description: ReactNode;
  status: ReactNode;
  action: ReactNode;
  selected?: boolean;
}

/** A navigable content row with a separate action area. */
export function ListRow({ href, onNavigate, icon, title, description, status, action, selected = false }: ListRowProps) {
  return (
    <div className={`list-row${selected ? " list-row--selected" : ""}`}>
      <a
        className={`list-row__link${icon === undefined ? " list-row__link--no-icon" : ""}`}
        href={href}
        aria-current={selected ? "page" : undefined}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onNavigate();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onNavigate();
        }}
      >
        {icon === undefined ? null : <span className="list-row__icon" aria-hidden="true">{icon}</span>}
        <span className="list-row__copy">
          <strong className="list-row__title">{title}</strong>
          <span className="list-row__description">{description}</span>
        </span>
        <span className="list-row__status">{status}</span>
      </a>
      <div className="list-row__action">{action}</div>
    </div>
  );
}
