import type { ReactElement } from "react";

import { ColorField, UnitInput } from "../../../dashboard/ui";
import type { OverlayElementEditorProps } from "../../contract";
import { overlayAlertElementEditorTexts } from "./locale";
import { DEFAULT_OVERLAY_ALERT_CONFIG, parseOverlayAlertConfig } from "./state";

export default function OverlayAlertEditor({ config, onChange, language = "de", readOnly = false }: OverlayElementEditorProps): ReactElement {
  const labels = overlayAlertElementEditorTexts[language];
  const values = parseOverlayAlertConfig(config) ?? DEFAULT_OVERLAY_ALERT_CONFIG;
  return <div className="config-section overlay-alert-element-editor">
    <ColorField
      id="overlay-alert-text-color"
      label={labels.textColor}
      value={values.textColor}
      unsetLabel={labels.unset}
      clearLabel={labels.clear}
      disabled={readOnly}
      onChange={(textColor) => {
        if (!readOnly && textColor !== undefined) onChange({ ...values, textColor });
      }}
    />
    <UnitInput
      label={labels.fontSize}
      unit={labels.fontSizeUnit}
      value={values.fontSize}
      min={12}
      max={72}
      disabled={readOnly}
      onChange={(fontSize) => {
        if (!readOnly && typeof fontSize === "number") onChange({ ...values, fontSize });
      }}
    />
  </div>;
}
