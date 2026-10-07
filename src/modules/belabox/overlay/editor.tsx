import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { belaboxOverlayLabels } from "./locale";

const Editor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = belaboxOverlayLabels(language);
  const disabled = readOnly ? { title: readOnlyReason } : {};
  return <div className="config-section">
    <label className="config-field">
      <span>{labels.layout}</span>
      <select
        aria-label={labels.layout}
        value={config.layout === "detail" ? "detail" : "compact"}
        disabled={readOnly}
        {...disabled}
        onChange={(event) => { if (!readOnly) onChange({ ...config, layout: event.currentTarget.value }); }}
      >
        <option value="compact">{labels.compact}</option>
        <option value="detail">{labels.detail}</option>
      </select>
    </label>
    <label className="config-field">
      <span>{labels.unit}</span>
      <select
        aria-label={labels.unit}
        value={config.unit === "mbps" ? "mbps" : "kbps"}
        disabled={readOnly}
        {...disabled}
        onChange={(event) => { if (!readOnly) onChange({ ...config, unit: event.currentTarget.value }); }}
      >
        <option value="kbps">{labels.kbps}</option>
        <option value="mbps">{labels.mbps}</option>
      </select>
    </label>
    <label className="config-field">
      <input
        type="checkbox"
        checked={config.hideWhenHealthy === true}
        disabled={readOnly}
        {...disabled}
        onChange={(event) => { if (!readOnly) onChange({ ...config, hideWhenHealthy: event.currentTarget.checked }); }}
      />
      <span>{labels.hideWhenHealthy}</span>
    </label>
    <p className="muted">{labels.onDemandNotice}</p>
  </div>;
};

export default Editor;
