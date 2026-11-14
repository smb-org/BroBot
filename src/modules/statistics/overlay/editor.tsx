import { useEffect, useRef, useState, type ReactElement } from "react";

import type { OverlayElementEditorProps } from "../../contract";
import { foldStatisticsWord } from "../domain";
import { statisticsWordCounterLabels } from "./locale";
import {
  DEFAULT_STATISTICS_WORD_COUNTER_CONFIG,
  parseStatisticsWordCounterConfig,
  type StatisticsWordCounterShow,
} from "./state";

import "./editor.css";

export default function StatisticsWordCounterEditor({ config, onChange, language = "de", readOnly = false, readOnlyReason }: OverlayElementEditorProps): ReactElement {
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
    const parsed = parseStatisticsWordCounterConfig({ word: rawWord, label: nextLabel, show: values.show });
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

  const changeShow = (show: StatisticsWordCounterShow): void => {
    if (!readOnly) onChange({ ...values, show });
  };

  const wordIsValid = parseStatisticsWordCounterConfig({ word: wordInput }) !== null;
  const number = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US");
  const previewCounts = values.show === "both"
    ? `${labels.stream} ${number.format(128)} · ${labels.total} ${number.format(1_248)}`
    : values.show === "stream"
      ? `${labels.stream} ${number.format(128)}`
      : `${labels.total} ${number.format(1_248)}`;

  return <div className="statistics-word-counter-editor">
    <label className="statistics-word-counter-editor__field" htmlFor="statistics-word-counter-word">
      <span>{labels.word}</span>
      <input id="statistics-word-counter-word" type="text" value={wordInput} maxLength={80}
        disabled={readOnly} title={readOnly ? readOnlyReason : undefined} aria-invalid={!wordIsValid}
        onChange={(event) => changeWord(event.currentTarget.value)} />
      <span className="statistics-word-counter-editor__hint" aria-live="polite">{wordIsValid ? "" : labels.invalidWord}</span>
    </label>
    <label className="statistics-word-counter-editor__field" htmlFor="statistics-word-counter-label">
      <span>{labels.label}</span>
      <input id="statistics-word-counter-label" type="text" value={labelInput} maxLength={80}
        disabled={readOnly} title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeLabel(event.currentTarget.value)} />
    </label>
    <label className="statistics-word-counter-editor__field" htmlFor="statistics-word-counter-show">
      <span>{labels.show}</span>
      <select id="statistics-word-counter-show" value={values.show} disabled={readOnly}
        title={readOnly ? readOnlyReason : undefined}
        onChange={(event) => changeShow(event.currentTarget.value as StatisticsWordCounterShow)}>
        <option value="stream">{labels.stream}</option>
        <option value="total">{labels.total}</option>
        <option value="both">{labels.both}</option>
      </select>
    </label>
    <p className="statistics-word-counter-editor__preview" aria-label={labels.preview}>
      {labels.preview}: {labelInput || wordInput} · {previewCounts}
    </p>
  </div>;
}
