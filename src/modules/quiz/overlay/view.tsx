import { useEffect, useMemo, useState, type CSSProperties, type ReactElement } from "react";

import type { ModuleOverlayElementProps } from "../../contract";
import { Icon } from "../../../dashboard/ui";
import { quizOverlayTexts } from "./locale";
import { DEFAULT_QUIZ_OVERLAY_CONFIG, QUIZ_RESULTS_DISPLAY_MS, parseQuizOverlayConfig, parseQuizOverlayState } from "./state";

import "./view.css";

const formatClock = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, "0");
  return `${String(minutes)}:${remainder}`;
};

const QuizOverlay = ({ config: rawConfig, state: rawState, language = "en" }: ModuleOverlayElementProps): ReactElement | null => {
  const current = useMemo(() => parseQuizOverlayState(rawState), [rawState]);
  const config = parseQuizOverlayConfig(rawConfig) ?? DEFAULT_QUIZ_OVERLAY_CONFIG;
  const labels = quizOverlayTexts(language);
  const serverNow = current?.serverNow === undefined ? Number.NaN : Date.parse(current.serverNow);
  const [clock, setClock] = useState(() => ({
    serverNow,
    currentTime: Number.isFinite(serverNow) ? serverNow : 0,
  }));

  useEffect(() => {
    const shouldTick = current?.phase === "results" || current?.phase === "open" && !current.paused;
    if (!shouldTick || !Number.isFinite(serverNow)) return;
    const offset = serverNow - performance.now();
    const timer = window.setInterval(() => {
      const monotonicNow = performance.now();
      const currentTime = monotonicNow + offset;
      setClock({ serverNow, currentTime });
      const resultAt = current.resultAt === undefined ? Number.NaN : Date.parse(current.resultAt);
      if (current.phase === "results" && Number.isFinite(resultAt) && currentTime >= resultAt + QUIZ_RESULTS_DISPLAY_MS) {
        window.clearInterval(timer);
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [current?.phase, current?.paused, current?.resultAt, serverNow]);

  if (current === null) return null;

  const progress = config.showQuestionProgress
    ? labels.questionProgress(current.questionIndex + 1, current.questionCount)
    : "";
  const deadline = current.phaseEndsAt === null ? Number.NaN : Date.parse(current.phaseEndsAt);
  const calibratedNow = clock.serverNow === serverNow ? clock.currentTime : serverNow;
  const resultAt = current.resultAt === undefined ? Number.NaN : Date.parse(current.resultAt);
  if (current.phase === "results" && Number.isFinite(resultAt) && calibratedNow >= resultAt + QUIZ_RESULTS_DISPLAY_MS) return null;
  const remainingSeconds = current.paused
    ? current.remainingMs === null ? null : Math.ceil(current.remainingMs / 1_000)
    : current.phase === "open" && Number.isFinite(deadline)
      ? Math.max(0, Math.ceil((deadline - calibratedNow) / 1_000))
      : null;
  const optionCounts = current.phase === "reveal" ? current.answerDistribution ?? [] : [];
  const totalAnswers = optionCounts.reduce((total, count) => total + count, 0);
  const ranking = current.phase === "results" ? (current.ranking ?? []).slice(0, 10) : [];
  const maximumCorrect = Math.max(1, ...ranking.map(({ correct }) => correct));
  const style = {
    "--quiz-background": config.backgroundColor,
    "--quiz-text": config.textColor,
    "--quiz-secondary": config.secondaryColor,
    "--quiz-accent": config.accentColor,
    "--quiz-correct": config.correctColor,
  } as CSSProperties;

  return <section className="quiz-session-overlay" style={style} data-phase={current.phase} data-paused={current.paused}>
    <header className="quiz-session-overlay__header">
      <span className="quiz-session-overlay__progress">{current.phase === "results" ? "\u00a0" : progress || "\u00a0"}</span>
      <span className="quiz-session-overlay__phase-status" aria-live={current.paused ? "polite" : "off"}>
        {current.paused ? labels.paused(remainingSeconds === null ? null : formatClock(remainingSeconds))
          : remainingSeconds === null ? "\u00a0"
            : labels.remaining(formatClock(remainingSeconds))}
      </span>
    </header>

    <h2 className="quiz-session-overlay__question" title={current.phase === "results" ? labels.results : current.question}>
      {current.phase === "results" ? labels.results : current.question}
    </h2>

    {current.phase === "results" ? <ol className="quiz-session-overlay__ranking" aria-label={labels.results}>
      {ranking.length === 0 ? <li className="quiz-session-overlay__empty">{labels.noParticipants}</li> : ranking.map((entry) => {
        const percent = Math.round((entry.correct / maximumCorrect) * 100);
        return <li className="quiz-session-overlay__rank" key={`${String(entry.rank)}:${entry.login}`}>
          <span className="quiz-session-overlay__rank-number">{entry.rank}</span>
          <span className="quiz-session-overlay__login" title={entry.login}>{entry.login}</span>
          <span className="quiz-session-overlay__rank-bar" aria-hidden="true">
            <span style={{ width: `${String(percent)}%` }} />
          </span>
          <span className="quiz-session-overlay__correct-count">{labels.correctAnswers(entry.correct)}</span>
        </li>;
      })}
    </ol> : <ol className={`quiz-session-overlay__options${current.phase === "reveal" ? " is-reveal" : ""}`}>
      {current.options.map((option, index) => {
        const count = optionCounts[index] ?? 0;
        const percent = totalAnswers === 0 ? 0 : Math.round((count / totalAnswers) * 100);
        const correct = current.phase === "reveal" && current.correctIndex === index;
        return <li className="quiz-session-overlay__option" data-correct={correct} key={`${String(index)}:${option}`}>
          <span className="quiz-session-overlay__option-number">{String(index + 1)}</span>
          <span className="quiz-session-overlay__option-content">
            <span className="quiz-session-overlay__option-label" title={option}>{option}</span>
            {correct ? <span className="quiz-session-overlay__correct-label"><Icon name="copied" size={20} />{labels.correct}</span> : null}
            {current.phase === "reveal" ? <span className="quiz-session-overlay__option-bar" aria-hidden="true">
              <span style={{ width: `${String(percent)}%` }} />
            </span> : null}
          </span>
          {current.phase === "reveal" ? <span className="quiz-session-overlay__answer-count">
            {config.showPercent ? labels.percentage(percent) : labels.answerCount(count)}
          </span> : null}
        </li>;
      })}
    </ol>}
  </section>;
};

export default QuizOverlay;
