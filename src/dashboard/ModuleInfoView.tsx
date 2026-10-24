import type { ReactElement } from "react";

import type { TemplateVariable } from "../template";
import { formatTemplateVariableToken, templateVariableParameter } from "./ui/template-text-field-model";
import { TokenChip } from "./ui";
import { dashboardTexts, type DashboardLanguage } from "./locale";
import "./ModuleInfoView.css";

export interface ModuleInfoViewProperties {
  description?: string;
  mandatoryReason?: string;
  templateVariableCatalog: readonly TemplateVariable[];
  language: DashboardLanguage;
}

export const ModuleInfoView = ({ description, mandatoryReason, templateVariableCatalog, language }: ModuleInfoViewProperties): ReactElement => {
  const texts = dashboardTexts(language).module;

  return <section className="module-info-view" aria-label={texts.infoTitle}>
    {description === undefined ? null : <p className="module-info-view__description">{description}</p>}
    {mandatoryReason === undefined ? null : <p className="module-info-view__mandatory-reason"><strong>{texts.mandatoryReasonLabel}:</strong> {mandatoryReason}</p>}
    <section className="module-info-view__catalog" aria-label={texts.templateVariablesTitle}>
      <h2>{texts.templateVariablesTitle}</h2>
      {templateVariableCatalog.length === 0
        ? <p className="module-info-view__empty">{texts.templateVariablesEmpty}</p>
        : <>
          <p className="module-info-view__where-to-use">{texts.templateVariablesWhere}</p>
          <ul className="module-info-view__list">
            {templateVariableCatalog.map((variable) => {
              const pickerCopy = variable.picker?.[language];
              const tokenParameter = templateVariableParameter(variable.parameters, variable.parameterDefault);
              const token = formatTemplateVariableToken({
                name: variable.name,
                ...(tokenParameter === undefined ? {} : { parameter: tokenParameter }),
              });
              return <li className="module-info-view__entry" key={variable.name}>
                <h3>{pickerCopy?.label ?? variable.name}</h3>
                <code className="module-info-view__name">{variable.name}</code>
                <p className="module-info-view__meaning">{pickerCopy?.description ?? variable.localizedDescription?.[language] ?? variable.name}</p>
                <div className="module-info-view__example">
                  <span>{texts.templateVariableExample}</span>
                  <TokenChip token={token} {...(pickerCopy === undefined ? {} : { description: pickerCopy.description })} />
                </div>
              </li>;
            })}
          </ul>
        </>}
    </section>
  </section>;
};
