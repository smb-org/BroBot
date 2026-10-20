import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { emoteSlotOverlayLabels } from "./locale";
import {
  DEFAULT_SLOT_OVERLAY_CONFIG,
  parseSlotOverlayConfig,
  slotOverlayConfigToJson,
  slotOverlayContrastRatio,
} from "./state";

const SlotOverlayEditor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = emoteSlotOverlayLabels(language);
  const values = parseSlotOverlayConfig(config) ?? DEFAULT_SLOT_OVERLAY_CONFIG;
  const textContrast = slotOverlayContrastRatio(values.textColor, values.backgroundColor);
  const secondaryContrast = slotOverlayContrastRatio(values.secondaryColor, values.backgroundColor);
  const highlightContrast = slotOverlayContrastRatio(values.highlightColor, values.backgroundColor);
  const lowestContrast = Math.min(textContrast, secondaryContrast, highlightContrast);
  const contrastLabel = lowestContrast.toFixed(1);
  const isLowContrast = lowestContrast < 4.5;
  const disabledProps = readOnly ? { title: readOnlyReason, "aria-describedby": readOnlyReason === undefined ? undefined : "overlay-editor-readonly-reason" } : {};
  const updateColor = (key: "backgroundColor" | "textColor" | "secondaryColor" | "highlightColor", next: string): void => {
    if (readOnly || !/^#[0-9a-f]{6}$/iu.test(next)) return;
    onChange(slotOverlayConfigToJson({ ...values, [key]: next }));
  };

  return <div className="config-section emote-slot-overlay-editor">
    <p>{labels.editorNote}</p>
    <label className="config-field config-field--narrow">
      <span>{labels.backgroundColor}</span>
      <input type="color" aria-label={labels.backgroundColor} value={values.backgroundColor}
        disabled={readOnly} {...disabledProps}
        onChange={(event) => updateColor("backgroundColor", event.currentTarget.value)} />
    </label>
    <label className="config-field config-field--narrow">
      <span>{labels.textColor}</span>
      <input type="color" aria-label={labels.textColor} value={values.textColor}
        disabled={readOnly} {...disabledProps}
        onChange={(event) => updateColor("textColor", event.currentTarget.value)} />
    </label>
    <label className="config-field config-field--narrow">
      <span>{labels.secondaryColor}</span>
      <input type="color" aria-label={labels.secondaryColor} value={values.secondaryColor}
        disabled={readOnly} {...disabledProps}
        onChange={(event) => updateColor("secondaryColor", event.currentTarget.value)} />
    </label>
    <label className="config-field config-field--narrow">
      <span>{labels.highlightColor}</span>
      <input type="color" aria-label={labels.highlightColor} value={values.highlightColor}
        disabled={readOnly} {...disabledProps}
        onChange={(event) => updateColor("highlightColor", event.currentTarget.value)} />
    </label>
    <p className="emote-slot-overlay-editor__contrast" data-status={isLowContrast ? "warning" : "ok"} role="status" aria-live="polite">
      {isLowContrast ? labels.contrastWarning(contrastLabel) : labels.contrastGood(contrastLabel)}
    </p>
  </div>;
};

export default SlotOverlayEditor;
