import type { ReactElement } from "react";

import { SwitchRow, UnitInput } from "../../../dashboard/ui";
import type { OverlayElementEditorProps } from "../../contract";
import { votekickOverlayLabels } from "./locale";

// The read-only reason reaches the shared fields through the disabled-field reason context.
const VotekickOverlayEditor = ({ config, onChange, language = "en", readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const labels = votekickOverlayLabels(language);
  const showCountdown = config.showCountdown !== false;
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;

  return <div className="overlay-editor__module-fields">
    <SwitchRow label={labels.showCountdown} checked={showCountdown} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, showCountdown: checked }); }} />
    <UnitInput label={labels.hideAfterCloseSeconds} ariaLabel={`${labels.hideAfterCloseSeconds} (${labels.seconds})`} unit={labels.seconds}
      value={hideAfterCloseSeconds} min={0} max={120} step={1} disabled={readOnly}
      onChange={(next) => {
        if (!readOnly && typeof next === "number") {
          onChange({ ...config, hideAfterCloseSeconds: Math.max(0, Math.min(120, Math.trunc(next))) });
        }
      }} />
  </div>;
};

export default VotekickOverlayEditor;
