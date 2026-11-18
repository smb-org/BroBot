import type { ReactElement } from "react";

import { Select, SwitchRow } from "../../../dashboard/ui";
import type { OverlayElementEditorProps } from "../../contract";
import { belaboxOverlayLabels } from "./locale";

// The read-only reason reaches the shared fields through the disabled-field reason context.
const Editor = ({ config, onChange, language = "en", readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const labels = belaboxOverlayLabels(language);
  return <div className="overlay-editor__module-fields">
    <Select label={labels.layout} value={config.layout === "detail" ? "detail" : "compact"} disabled={readOnly}
      options={[{ value: "compact", label: labels.compact }, { value: "detail", label: labels.detail }]}
      onChange={(value) => { if (!readOnly && value !== null) onChange({ ...config, layout: value }); }} />
    <Select label={labels.unit} value={config.unit === "mbps" ? "mbps" : "kbps"} disabled={readOnly}
      options={[{ value: "kbps", label: labels.kbps }, { value: "mbps", label: labels.mbps }]}
      onChange={(value) => { if (!readOnly && value !== null) onChange({ ...config, unit: value }); }} />
    <SwitchRow label={labels.hideWhenHealthy} checked={config.hideWhenHealthy === true} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, hideWhenHealthy: checked }); }} />
    <p className="muted">{labels.onDemandNotice}</p>
  </div>;
};

export default Editor;
