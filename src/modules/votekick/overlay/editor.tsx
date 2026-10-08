import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { votekickOverlayLabels } from "./locale";

const VotekickOverlayEditor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = votekickOverlayLabels(language);
  const showCountdown = config.showCountdown !== false;
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;
  const disabledProps = readOnly ? { title: readOnlyReason, "aria-describedby": readOnlyReason === undefined ? undefined : "overlay-editor-readonly-reason" } : {};

  return <div className="config-section">
    <label className="config-field">
      <span>{labels.showCountdown}</span>
      <input
        type="checkbox"
        aria-label={labels.showCountdown}
        checked={showCountdown}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => { if (!readOnly) onChange({ ...config, showCountdown: event.currentTarget.checked }); }}
      />
    </label>
    <label className="config-field">
      <span>{labels.hideAfterCloseSeconds} ({labels.seconds})</span>
      <input
        type="number"
        aria-label={`${labels.hideAfterCloseSeconds} (${labels.seconds})`}
        min={0}
        max={120}
        step={1}
        value={hideAfterCloseSeconds}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => {
          if (!readOnly && event.currentTarget.value !== "") {
            const value = Math.max(0, Math.min(120, Math.trunc(Number(event.currentTarget.value))));
            onChange({ ...config, hideAfterCloseSeconds: value });
          }
        }}
      />
    </label>
  </div>;
};

export default VotekickOverlayEditor;
