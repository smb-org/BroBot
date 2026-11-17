import { createElement, lazy, Suspense, type ComponentType, type LazyExoticComponent, type ReactElement } from "react";

import { Section } from "./ui";
import type {
  ModuleLanguage,
  ModuleRegisteredStatisticsSection,
  ModuleStatisticsSectionScope,
} from "../modules/contract";
import "./StatisticsSections.css";

const LoadingSection = (): ReactElement => <div className="statistics-section-loading" aria-busy="true" aria-hidden="true">
  <span />
  <span />
</div>;

type SectionComponent = LazyExoticComponent<ComponentType<{
  channelId: string;
  language: ModuleLanguage;
  scope: ModuleStatisticsSectionScope;
}>>;

// One lazy component per loader, created outside render so section state survives re-renders.
const sectionComponents = new WeakMap<ModuleRegisteredStatisticsSection["load"], SectionComponent>();
const sectionComponent = (load: ModuleRegisteredStatisticsSection["load"]): SectionComponent => {
  const existing = sectionComponents.get(load);
  if (existing !== undefined) return existing;
  const created = lazy(load);
  sectionComponents.set(load, created);
  return created;
};

const StatisticsSection = ({
  section,
  channelId,
  language,
  scope,
}: {
  section: ModuleRegisteredStatisticsSection;
  channelId: string;
  language: ModuleLanguage;
  scope: ModuleStatisticsSectionScope;
}): ReactElement => {
  return <Section title={section.title[language]}>
    <Suspense fallback={<LoadingSection />}>
      {createElement(sectionComponent(section.load), { channelId, language, scope })}
    </Suspense>
  </Section>;
};

export const StatisticsSections = ({
  sections,
  enabledModuleIds,
  channelId,
  language,
  scope,
}: {
  sections: readonly ModuleRegisteredStatisticsSection[];
  enabledModuleIds: readonly string[];
  channelId: string;
  language: ModuleLanguage;
  scope: ModuleStatisticsSectionScope;
}): ReactElement | null => {
  const enabled = new Set(enabledModuleIds);
  const visible = sections.filter((section) => enabled.has(section.moduleId));
  if (visible.length === 0) return null;
  return <div className="statistics-sections">
    {visible.map((section) => <StatisticsSection
      key={`${section.moduleId}:${section.id}`}
      section={section}
      channelId={channelId}
      language={language}
      scope={scope}
    />)}
  </div>;
};
