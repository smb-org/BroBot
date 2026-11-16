import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { ColorField } from "../../../dashboard/ui";
import { emoteSlotOverlayLabels } from "./locale";
import { DEFAULT_SLOT_OVERLAY_CONFIG, parseSlotOverlayConfig } from "./state";

const SlotOverlayEditor = ({ config, onChange, language = "en", readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const labels = emoteSlotOverlayLabels(language);
  const values = parseSlotOverlayConfig(config) ?? DEFAULT_SLOT_OVERLAY_CONFIG;
  return <div className="config-section emote-slot-overlay-editor">
    <ColorField id="emote-slot-border-color" label={labels.borderColor} value={values.borderColor}
      unsetLabel={labels.colorUnset} clearLabel={labels.colorClear} disabled={readOnly}
      onChange={(borderColor) => {
        if (readOnly) return;
        if (borderColor !== undefined) onChange({ ...values, borderColor });
        else {
          const next = { ...config };
          delete next.borderColor;
          onChange(next);
        }
      }} />
  </div>;
};

export default SlotOverlayEditor;
