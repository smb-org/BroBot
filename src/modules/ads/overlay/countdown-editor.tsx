type EditorJsonValue = string | number | boolean | null | readonly EditorJsonValue[] | { readonly [key: string]: EditorJsonValue };
type EditorJsonObject = Readonly<Record<string, EditorJsonValue>>;
import { adsCountdownLabels } from "./countdown-locale";

interface AdsCountdownEditorProperties {
  config: EditorJsonObject;
  onChange: (config: EditorJsonObject) => void;
  language?: "de" | "en";
}

const AdsCountdownEditor = ({ config, onChange, language = "en" }: AdsCountdownEditorProperties) => {
  const showSnoozeInfo = config.showSnoozeInfo === true;
  const labels = adsCountdownLabels(language);

  return <label className="ads-countdown-editor">
    <input
      type="checkbox"
      checked={showSnoozeInfo}
      onChange={(event) => { onChange({ ...config, showSnoozeInfo: event.currentTarget.checked }); }}
    />
    <span>{labels.showSnoozeInfo}</span>
  </label>;
};

export default AdsCountdownEditor;
