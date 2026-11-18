import type { ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { ColorField, SwitchRow } from "../../../dashboard/ui";
import { isOverlayHexColor } from "../../contract";
import { quizOverlayTexts } from "./locale";
import { DEFAULT_QUIZ_OVERLAY_CONFIG, parseQuizOverlayConfig } from "./state";

const QuizOverlayEditor = ({ config, onChange, language = "en", readOnly = false }: OverlayElementEditorProps): ReactElement => {
  const labels = quizOverlayTexts(language);
  const values = parseQuizOverlayConfig(config) ?? DEFAULT_QUIZ_OVERLAY_CONFIG;
  const changeCorrectColor = (value: string): void => {
    if (readOnly || !isOverlayHexColor(value)) return;
    onChange({ ...values, correctColor: value });
  };

  return <div className="overlay-editor__module-fields quiz-overlay-editor">
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
    <ColorField id="quiz-correct-color" label={labels.correctColor} value={values.correctColor}
      unsetLabel={labels.colorUnset} clearLabel={labels.colorClear} disabled={readOnly}
      onChange={(value) => {
        if (value !== undefined) changeCorrectColor(value);
        else if (!readOnly) onChange({ ...values, correctColor: DEFAULT_QUIZ_OVERLAY_CONFIG.correctColor });
      }} />
  </div>;
};

export default QuizOverlayEditor;
