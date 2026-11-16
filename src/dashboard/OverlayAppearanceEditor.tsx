import type { ReactElement } from "react";

import type {
  ModuleOverlayAppearanceDefinition,
  OverlayAppearanceConfig,
  OverlayAppearancePart,
} from "../modules/contract";
import { overlayAppearanceContrastRatio, resolveOverlayAppearance } from "../overlay/appearance";
import { ColorField } from "./ui";
import { overlayAppearanceEditorTexts } from "./overlay-appearance-locale";

import "./overlay-appearance.css";

interface OverlayAppearanceEditorProps {
  definition: ModuleOverlayAppearanceDefinition;
  value: OverlayAppearanceConfig;
  language: "de" | "en";
  onChange: (appearance: OverlayAppearanceConfig) => void;
  disabled?: boolean;
}

const PART_ORDER: readonly OverlayAppearancePart[] = ["background", "text", "secondaryText", "accent"];

const OverlayAppearanceEditor = ({ definition, value, language, onChange, disabled = false }: OverlayAppearanceEditorProps): ReactElement => {
  const labels = overlayAppearanceEditorTexts[language];
  const appearance = resolveOverlayAppearance(value, definition);
  const background = appearance.background ?? definition.defaults.background ?? "transparent";
  const ratios = ["text", "secondaryText"].flatMap((part) => {
    if (!definition.parts.includes(part as OverlayAppearancePart)) return [];
    const color = appearance[part as OverlayAppearancePart];
    const ratio = color === undefined ? null : overlayAppearanceContrastRatio(color, background);
    return ratio === null ? [] : [ratio];
  });
  const contrast = ratios.length === 0 ? null : Math.min(...ratios);
  const lowContrast = contrast === null || contrast < 4.5;
  const contrastLabel = contrast?.toFixed(1) ?? "";

  const changePart = (part: OverlayAppearancePart, next: string | undefined): void => {
    onChange({ ...appearance, [part]: next ?? definition.defaults[part] });
  };

  return <section className="config-section overlay-appearance-editor" role="group" aria-label={labels.heading}>
    <h3 className="section-heading">{labels.heading}</h3>
    <div className="overlay-appearance-editor__fields">
      {PART_ORDER.filter((part) => definition.parts.includes(part)).map((part) => {
        const label = labels[part];
        return <ColorField
          key={part}
          id={`overlay-appearance-${part}`}
          label={label}
          value={appearance[part]}
          unsetLabel={labels.useDefault}
          clearLabel={labels.reset}
          disabled={disabled}
          allowTransparent={part === "background"}
          {...(part === "background" ? { transparentLabel: labels.transparent } : {})}
          onChange={(next) => { changePart(part, next); }}
        />;
      })}
    </div>
    <p className="overlay-appearance-editor__contrast" data-status={lowContrast ? "warning" : "ok"} role="status" aria-live="polite">
      {contrast === null ? labels.contrastUnknown : lowContrast ? labels.contrastWarning(contrastLabel) : labels.contrastGood(contrastLabel)}
    </p>
  </section>;
};

export { OverlayAppearanceEditor };
