import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { chatVotingOverlayLabels } from "./locale";

const ChatVotingOverlayEditor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = chatVotingOverlayLabels(language);
  const layout = config.layout === "strip" ? "strip" : "bars";
  const showPercent = config.showPercent !== false;
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;
  const width = typeof config.width === "number" ? config.width : 480;
  const disabledProps = readOnly ? { title: readOnlyReason, "aria-describedby": readOnlyReason === undefined ? undefined : "overlay-editor-readonly-reason" } : {};

  return <div className="config-section">
    <label className="config-field">
      <span>{labels.layout}</span>
      <select
        aria-label={labels.layout}
        value={layout}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => { if (!readOnly) onChange({ ...config, layout: event.currentTarget.value }); }}
      >
        <option value="strip">{labels.strip}</option>
        <option value="bars">{labels.bars}</option>
      </select>
    </label>
    <label className="config-field">
      <span>{labels.showPercent}</span>
      <input
        type="checkbox"
        aria-label={labels.showPercent}
        checked={showPercent}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => { if (!readOnly) onChange({ ...config, showPercent: event.currentTarget.checked }); }}
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
    <label className="config-field">
      <span>{labels.width}</span>
      <input
        type="number"
        aria-label={labels.width}
        min={200}
        max={1920}
        step={1}
        value={width}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => {
          if (!readOnly && event.currentTarget.value !== "") {
            onChange({ ...config, width: Math.max(200, Math.min(1920, Math.trunc(Number(event.currentTarget.value)))) });
          }
        }}
      />
    </label>
  </div>;
};

export default ChatVotingOverlayEditor;
