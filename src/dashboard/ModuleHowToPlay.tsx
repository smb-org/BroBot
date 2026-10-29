import type { ReactElement } from "react";

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
}

export function ModuleHowToPlay({ module, settings, language, loading = false }: ModuleHowToPlayProperties): ReactElement {
  const copy = dashboardTexts(language).module.howToPlay;
  const rows = deriveModuleHowToPlay(module, settings, language);

  return <section className="module-how-to-play" aria-labelledby={`module-how-to-play-${module.id}`} aria-busy={loading}>
    <h2 id={`module-how-to-play-${module.id}`}>{copy.title}</h2>
    <div className="module-how-to-play__rows">
      {/* While loading, the rows keep their real text invisible so the block has exactly its final height. */}
      {rows.map((row, index) => <p key={`${row.kind}-${String(index)}`} aria-hidden={loading ? "true" : undefined}>
        <strong>{copy[row.label]}:</strong> {row.text}
      </p>)}
    </div>
  </section>;
}
