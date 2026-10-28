import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { SwitchRow } from "../../../dashboard/ui";
import { quizOverlayTexts } from "./locale";
import { DEFAULT_QUIZ_OVERLAY_CONFIG, parseQuizOverlayConfig } from "./state";

const QuizOverlayEditor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = quizOverlayTexts(language);
  const values = parseQuizOverlayConfig(config) ?? DEFAULT_QUIZ_OVERLAY_CONFIG;
  const disabledProps = readOnly ? { title: readOnlyReason, "aria-describedby": readOnlyReason === undefined ? undefined : "overlay-editor-readonly-reason" } : {};
  const changeColor = (key: "backgroundColor" | "textColor" | "secondaryColor" | "accentColor" | "correctColor", value: string): void => {
    if (readOnly || !/^#[0-9a-f]{6}$/iu.test(value)) return;
    onChange({ ...values, [key]: value });
  };

  return <div className="config-section quiz-overlay-editor">
    <SwitchRow
      label={labels.showQuestionProgress}
      checked={values.showQuestionProgress}
      disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...values, showQuestionProgress: checked }); }}
    />
    <SwitchRow
      label={labels.showPercent}
      checked={values.showPercent}
      disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...values, showPercent: checked }); }}
    />
    {([
      ["backgroundColor", labels.backgroundColor],
      ["textColor", labels.textColor],
      ["secondaryColor", labels.secondaryColor],
      ["accentColor", labels.accentColor],
      ["correctColor", labels.correctColor],
    ] as const).map(([key, label]) => <label className="config-field config-field--narrow" key={key}>
      <span>{label}</span>
      <input
        type="color"
        aria-label={label}
        value={values[key]}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => changeColor(key, event.currentTarget.value)}
      />
    </label>)}
  </div>;
};

export default QuizOverlayEditor;
