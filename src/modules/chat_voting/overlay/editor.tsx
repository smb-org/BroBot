import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { Select, SwitchRow, UnitInput } from "../../../dashboard/ui";
import { chatVotingOverlayLabels } from "./locale";

// The read-only reason reaches the shared fields through the disabled-field reason context.
const ChatVotingOverlayEditor = ({ config, onChange, language = "en", readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const labels = chatVotingOverlayLabels(language);
  const layout = config.layout === "strip" ? "strip" : "bars";
  const showPercent = config.showPercent !== false;
  const showCountdown = config.showCountdown !== false;
  const useVoteColors = config.useVoteColors !== false;
  const hideAfterCloseSeconds = typeof config.hideAfterCloseSeconds === "number" ? config.hideAfterCloseSeconds : 15;

  return <div className="overlay-editor__module-fields">
    <SwitchRow label={labels.useVoteColors} checked={useVoteColors} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, useVoteColors: checked }); }} />
    <Select label={labels.layout} value={layout} disabled={readOnly}
      options={[{ value: "strip", label: labels.strip }, { value: "bars", label: labels.bars }]}
      onChange={(value) => { if (!readOnly && value !== null) onChange({ ...config, layout: value }); }} />
    <SwitchRow label={labels.showCountdown} checked={showCountdown} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, showCountdown: checked }); }} />
    <SwitchRow label={labels.showPercent} checked={showPercent} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, showPercent: checked }); }} />
    <UnitInput label={labels.hideAfterCloseSeconds} ariaLabel={`${labels.hideAfterCloseSeconds} (${labels.seconds})`} unit={labels.seconds}
      value={hideAfterCloseSeconds} min={0} max={120} step={1} disabled={readOnly}
      onChange={(next) => {
        if (!readOnly && typeof next === "number") {
          onChange({ ...config, hideAfterCloseSeconds: Math.max(0, Math.min(120, Math.trunc(next))) });
        }
      }} />
  </div>;
};

export default ChatVotingOverlayEditor;
