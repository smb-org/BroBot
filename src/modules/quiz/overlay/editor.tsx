import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { SwitchRow } from "../../../dashboard/ui";
import { isOverlayAppearanceColor, overlayAppearanceToJsonObject } from "../../../overlay/appearance";
import { quizOverlayTexts } from "./locale";
import { DEFAULT_QUIZ_OVERLAY_CONFIG, parseQuizOverlayConfig } from "./state";

const QuizOverlayEditor = ({ config, onChange, language = "en", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement => {
  const labels = quizOverlayTexts(language);
  const values = parseQuizOverlayConfig(config) ?? DEFAULT_QUIZ_OVERLAY_CONFIG;
  const disabledProps = readOnly ? { title: readOnlyReason, "aria-describedby": readOnlyReason === undefined ? undefined : "overlay-editor-readonly-reason" } : {};
  const changeCorrectColor = (value: string): void => {
    if (readOnly || !isOverlayAppearanceColor(value)) return;
    onChange({ ...values, correctColor: value, appearance: overlayAppearanceToJsonObject(values.appearance) });
  };

  return <div className="config-section quiz-overlay-editor">
    <SwitchRow
      label={labels.showQuestionProgress}
      checked={values.showQuestionProgress}
      disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...values, showQuestionProgress: checked, appearance: overlayAppearanceToJsonObject(values.appearance) }); }}
    />
    <SwitchRow
      label={labels.showPercent}
      checked={values.showPercent}
      disabled={readOnly}
      onChange={(checked) => { if (!readOnly) onChange({ ...values, showPercent: checked, appearance: overlayAppearanceToJsonObject(values.appearance) }); }}
    />
    <label className="config-field config-field--narrow">
      <span>{labels.correctColor}</span>
      <input
        type="color"
        aria-label={labels.correctColor}
        value={values.correctColor}
        disabled={readOnly}
        {...disabledProps}
        onChange={(event) => changeCorrectColor(event.currentTarget.value)}
      />
    </label>
  </div>;
};

export default QuizOverlayEditor;
