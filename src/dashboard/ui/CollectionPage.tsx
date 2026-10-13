import type { ReactElement, ReactNode } from "react";

import { dashboardCommonTexts } from "../locale";

export interface CollectionPageProps {
  title: string;
  toolbar: ReactNode;
  list: ReactNode;
  detail: ReactNode;
  empty?: ReactNode;
}

export function CollectionPage({ title, toolbar, list, detail, empty }: CollectionPageProps): ReactElement {
  const texts = dashboardCommonTexts();
  return (
    <div data-ui="" className="collection-page">
      <header className="collection-page__heading"><h1>{title}</h1></header>
      <div className="collection-page__body">
        <aside aria-label={`${title}: ${texts.chooseCollection}`} className="collection-page__list">
          <div className="collection-page__list-toolbar">{toolbar}</div>
          <div className="collection-page__list-content">
            {list ?? <div className="collection-page__empty">{empty ?? texts.noCollectionEntries}</div>}
          </div>
        </aside>
        <section aria-label={`${title}: ${texts.editSelection}`} className="collection-page__detail">{detail}</section>
      </div>
    </div>
  );
}
