import type { ReactElement } from "react";

import { Button, Led, ListRow } from "../../../dashboard/ui";
import type { ChatVote, ChatVoteTemplate } from "../contracts";
import { templateStartProblem } from "../domain";

export interface ChatVoteTemplateListLabels {
  untitled: string;
  running: string;
  incomplete: string;
  start: (title: string) => string;
  shortcutMeta: (shortcut: string) => string;
  templateMeta: (answerCount: number, duration: string) => string;
  problem: (problem: "answers" | "duration") => string;
}

export interface ChatVoteTemplateListProperties {
  templates: readonly ChatVoteTemplate[];
  selectedId?: string | null;
  vote: ChatVote | null;
  startsLockedReason: string | null;
  canOperate: boolean;
  pendingId: string | null;
  labels: ChatVoteTemplateListLabels;
  durationText: (seconds: number) => string;
  onSelect: (template: ChatVoteTemplate) => void;
  onStart: (template: ChatVoteTemplate) => void;
}

const displayTitle = (template: ChatVoteTemplate, untitled: string): string => template.title.trim() || untitled;

export function ChatVoteTemplateList({
  templates,
  selectedId = null,
  vote,
  startsLockedReason,
  canOperate,
  pendingId,
  labels,
  durationText,
  onSelect,
  onStart,
}: ChatVoteTemplateListProperties): ReactElement {
  return <div className="chat-voting-template-list">
    {templates.map((template) => {
      const title = displayTitle(template, labels.untitled);
      const isRunning = vote?.status === "open" && template.lastUsedAt === vote.openedAt;
      const problem = templateStartProblem(template);
      const lockReason = startsLockedReason ?? (problem === null ? null : labels.problem(problem));
      const canStart = canOperate && lockReason === null && !isRunning;
      const description = <span>
        {template.shortcut === null ? null : <><span className="mono">{labels.shortcutMeta(template.shortcut)}</span> · </>}
        {labels.templateMeta(template.freeTextMode === null ? template.labels.length : 0, durationText(template.durationSeconds))}
      </span>;
      return <ListRow
        key={template.id}
        href={`#${encodeURIComponent(template.id)}`}
        onNavigate={() => { onSelect(template); }}
        title={title}
        description={description}
        selected={template.id === selectedId}
        status={isRunning ? <Led status="green" word={labels.running} /> : problem === null ? null : <span className="chat-voting-template-list__incomplete">{labels.incomplete}</span>}
        action={isRunning ? null : <Button
          icon="player-play"
          iconOnly
          size="compact"
          ariaLabel={labels.start(title)}
          title={lockReason ?? labels.start(title)}
          disabled={!canStart || pendingId === template.id}
          onClick={() => { onStart(template); }}
        />}
      />;
    })}
  </div>;
}
