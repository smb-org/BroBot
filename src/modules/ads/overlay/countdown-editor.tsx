type EditorJsonValue = string | number | boolean | null | readonly EditorJsonValue[] | { readonly [key: string]: EditorJsonValue };
type EditorJsonObject = Readonly<Record<string, EditorJsonValue>>;
import { SwitchRow } from "../../../dashboard/ui";
import { adsCountdownLabels } from "./countdown-locale";

interface AdsCountdownEditorProperties {
  config: EditorJsonObject;
  onChange: (config: EditorJsonObject) => void;
  language?: "de" | "en";
  readOnly?: boolean;
}

// The read-only reason reaches the switch through the disabled-field reason context.
const AdsCountdownEditor = ({ config, onChange, language = "en", readOnly = false }: AdsCountdownEditorProperties) => {
  const showSnoozeInfo = config.showSnoozeInfo === true;
  const labels = adsCountdownLabels(language);

  return <div className="overlay-editor__module-fields">
    <SwitchRow label={labels.showSnoozeInfo} checked={showSnoozeInfo} disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...config, showSnoozeInfo: checked }); }} />
  </div>;
};

export default AdsCountdownEditor;
