import type { ReactElement, ReactNode } from "react";

import type { BotModule } from "../modules/contract";
import type { DashboardLanguage } from "./locale";
import { dashboardTexts } from "./locale";
import { deriveModuleHowToPlay } from "./module-how-to-play-model";
import "./ModuleHowToPlay.css";

export interface ModuleHowToPlayProperties {
  module: BotModule;
  settings: unknown;
  language: DashboardLanguage;
  loading?: boolean;
  /** Rendered at the end of the title row, e.g. the chat commands popover on pages whose header is full. */
  actions?: ReactNode;
}

export function ModuleHowToPlay({ module, settings, language, loading = false, actions }: ModuleHowToPlayProperties): ReactElement {
  const copy = dashboardTexts(language).module.howToPlay;
  const rows = deriveModuleHowToPlay(module, settings, language);

  return <section className="module-how-to-play" aria-labelledby={`module-how-to-play-${module.id}`} aria-busy={loading}>
    <div className="module-how-to-play__title">
      <h2 id={`module-how-to-play-${module.id}`}>{copy.title}</h2>
      {actions}
    </div>
    <div className="module-how-to-play__rows">
      {rows.map((row, index) => <div className="module-how-to-play__row" key={`${row.kind}-${String(index)}`}>
        {loading
          ? <span className="module-how-to-play__skeleton" aria-hidden="true" />
          : <p><strong>{copy[row.label]}:</strong> {row.text}</p>}
      </div>)}
    </div>
  </section>;
}
