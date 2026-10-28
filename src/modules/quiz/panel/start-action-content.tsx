import { useEffect, useState, type ReactElement } from "react";

import { Select } from "../../../dashboard/ui";
import type { ModuleImmediateActionContentProperties } from "../../contract";
import { quizCockpitTexts } from "../locale";
import { loadQuizCockpitSets, type QuizCockpitSet } from "./service";

export default function QuizStartActionContent({ channelId, language, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const labels = quizCockpitTexts(language);
  const [sets, setSets] = useState<QuizCockpitSet[] | null>(null);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [questionCount, setQuestionCount] = useState("all");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void loadQuizCockpitSets(channelId, controller.signal).then((result) => {
      setSets(result);
      setSelectedSetId(result[0]?.id ?? null);
      setQuestionCount("all");
    }).catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const selectedSet = sets?.find((set) => set.id === selectedSetId) ?? null;
  useEffect(() => {
    if (sets === null) {
      onReadinessChange?.(false, labels.loadError);
      return;
    }
    onReadinessChange?.(selectedSet !== null, selectedSet === null ? labels.noQuestionSets : null);
  }, [failed, labels.loadError, labels.noQuestionSets, onReadinessChange, selectedSet, sets]);

  return <div className="live-action-content live-action-content--quiz">
    <Select
      label={labels.chooseSet}
      value={selectedSetId}
      onChange={(value) => { setSelectedSetId(value); setQuestionCount("all"); }}
      name="setId"
      required
      busy={sets === null && !failed}
      placeholder={failed ? labels.loadError : labels.chooseSetPlaceholder}
      options={(sets ?? []).map((set) => ({
        value: set.id,
        label: set.name,
        description: labels.enabledQuestionCount(set.enabledQuestionCount),
      }))}
    />
    <Select
      label={labels.questionsLabel}
      value={questionCount}
      onChange={(value) => setQuestionCount(value ?? "")}
      name="questionCount"
      disabled={selectedSet === null}
      options={[
        { value: "all", label: labels.allQuestions },
        ...(selectedSet === null ? [] : Array.from({ length: selectedSet.enabledQuestionCount }, (_, index) => ({
          value: String(index + 1),
          label: labels.firstQuestions(index + 1),
        }))),
      ]}
    />
  </div>;
}
