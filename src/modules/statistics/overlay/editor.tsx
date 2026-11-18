import { useEffect, useRef, useState, type ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { Field, Select } from "../../../dashboard/ui";
import { foldStatisticsWord } from "../domain";
import { statisticsWordCounterLabels } from "./locale";
import { DEFAULT_STATISTICS_WORD_COUNTER_CONFIG, parseStatisticsWordCounterConfig } from "./state";

import "./editor.css";

export default function StatisticsWordCounterEditor({ config, onChange, language = "de", readOnly = false }: OverlayElementEditorProps): ReactElement {
  const values = parseStatisticsWordCounterConfig(config) ?? DEFAULT_STATISTICS_WORD_COUNTER_CONFIG;
  const labels = statisticsWordCounterLabels(language);
  const [wordInput, setWordInput] = useState(() => typeof config.word === "string" ? config.word : values.word);
  const [labelInput, setLabelInput] = useState(() => typeof config.label === "string" ? config.label : values.label);
  const [labelEdited, setLabelEdited] = useState(() => typeof config.label === "string" &&
    foldStatisticsWord(config.label) !== values.word);
  const committedWord = useRef(values.word);

  useEffect(() => {
    if (values.word === committedWord.current) return;
    committedWord.current = values.word;
    setWordInput(values.word);
  }, [values.word]);

  // Adjust during render (not in an effect) when the committed label changes from outside.
  const [syncedLabel, setSyncedLabel] = useState(config.label);
  if (config.label !== syncedLabel) {
    setSyncedLabel(config.label);
    if (typeof config.label === "string") setLabelInput(config.label);
  }

  const changeWord = (rawWord: string): void => {
    if (readOnly) return;
    setWordInput(rawWord);
    const nextLabel = labelEdited ? labelInput : rawWord.trim();
    const parsed = parseStatisticsWordCounterConfig({
      word: rawWord,
      label: nextLabel,
      show: values.show,
    });
    if (parsed === null) return;
    committedWord.current = parsed.word;
    if (!labelEdited) setLabelInput(nextLabel);
    onChange({ ...values, ...parsed });
  };

  const changeLabel = (nextLabel: string): void => {
    if (readOnly) return;
    setLabelInput(nextLabel);
    setLabelEdited(true);
    onChange({ ...values, label: nextLabel });
  };

  const wordIsValid = parseStatisticsWordCounterConfig({ word: wordInput }) !== null;
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US");
  const previewCounts = values.show === "both"
    ? `${labels.stream} ${number.format(128)} · ${labels.total} ${number.format(1_248)}`
    : values.show === "stream"
      ? `${labels.stream} ${number.format(128)}`
      : `${labels.total} ${number.format(1_248)}`;

  return <div className="statistics-word-counter-editor overlay-editor__module-fields">
    <Field label={labels.word} value={wordInput} disabled={readOnly}
      {...(wordIsValid ? {} : { error: labels.invalidWord })} normalize={(word) => word.slice(0, 80)}
      onChange={changeWord} />
    <Field label={labels.label} value={labelInput} disabled={readOnly}
      normalize={(label) => label.slice(0, 80)}
      onChange={changeLabel} />
    <Select label={labels.show} value={values.show} disabled={readOnly}
      options={[
        { value: "stream", label: labels.stream },
        { value: "total", label: labels.total },
        { value: "both", label: labels.both },
      ]}
      onChange={(show) => { if (!readOnly && show !== null) onChange({ ...values, show }); }} />
    <p className="statistics-word-counter-editor__preview" aria-label={labels.preview}>
      {labels.preview}: {labelInput || wordInput} · {previewCounts}
    </p>
  </div>;
}
