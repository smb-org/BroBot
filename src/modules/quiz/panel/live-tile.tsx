import { useState, type ReactElement } from "react";

import { Button } from "../../../dashboard/ui";
import type { ModuleLanguage, ModuleLiveTileSnapshot } from "../../contract";
import { quizCockpitTexts } from "../locale";
import { controlQuizSession } from "./service";
import "./live-tile.css";

type QuizTileSnapshot = Extract<ModuleLiveTileSnapshot, { kind: "quiz" }>;
type QuizAction = "next" | "pause" | "resume" | "end";

export const QuizLiveTile = ({ channelId, language, session, now, canManage, onRefresh, onMessage }: {
  channelId: string;
  language: ModuleLanguage;
  session: QuizTileSnapshot;
  now: number;
  canManage: boolean;
  onRefresh: () => void;
  onMessage: (message: string) => void;
}): ReactElement => {
  const copy = quizCockpitTexts(language);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remaining = session.phaseEndsAt === null ? null : Math.max(0, Math.ceil((Date.parse(session.phaseEndsAt) - now) / 1_000));
  const time = remaining === null ? null : `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, "0")}`;

  const run = async (action: QuizAction): Promise<void> => {
    if (!canManage || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await controlQuizSession(channelId, action);
      onMessage(action === "next" ? copy.advanced : action === "pause" ? copy.paused : action === "resume" ? copy.resumed : copy.ended);
      onRefresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return <article className="live-cockpit-quiz" data-testid="live-quiz-tile">
    <header className="live-cockpit-quiz__heading">
      <div><span className="live-cockpit-quiz__name">{copy.sessionTitle}</span><strong>{session.setName}</strong></div>
      {time === null || session.paused ? null : <span className="live-cockpit-quiz__time mono">{copy.timeLeft(time)}</span>}
    </header>
    <div className="live-cockpit-quiz__phase">
      <span>{copy.phase[session.phase]}</span>
      <span>{copy.questionProgress(session.questionIndex + 1, session.questionCount)}</span>
      {session.paused ? <strong>{copy.pausedLabel}</strong> : null}
    </div>
    <div className="live-cockpit-quiz__actions">
      <Button size="compact" variant="secondary" icon="skip-forward" disabled={busy || !canManage || session.phase === "results"} onClick={() => { void run("next"); }}>{copy.nextAction}</Button>
      <Button size="compact" variant="secondary" icon={session.paused ? "player-play" : "player-pause"} disabled={busy || !canManage || session.phase === "results"} onClick={() => { void run(session.paused ? "resume" : "pause"); }}>{session.paused ? copy.resumeAction : copy.pauseAction}</Button>
      <Button size="compact" variant="neutral" danger icon="square" disabled={busy || !canManage} onClick={() => { void run("end"); }}>{copy.endAction}</Button>
    </div>
    <p className="live-cockpit-quiz__feedback" role="status" aria-live="polite">{failed ? copy.controlError : "\u00a0"}</p>
  </article>;
};
