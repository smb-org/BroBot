import type { ReactElement } from "react";

import { StatusLed, ListRow } from "../../../dashboard/ui";
import type { ChatVote, ChatVoteTemplate } from "../contracts";
import { templateStartProblem } from "../domain";

interface ChatVoteTemplateListLabels {
  untitled: string;
  running: string;
  incomplete: string;
  shortcutMeta: (shortcut: string) => string;
  templateMeta: (answerCount: number, duration: string) => string;
  problem: (problem: "answers" | "duration") => string;
}

export interface ChatVoteTemplateListProperties {
  templates: readonly ChatVoteTemplate[];
  selectedId?: string | null;
  vote: ChatVote | null;
  labels: ChatVoteTemplateListLabels;
  durationText: (seconds: number) => string;
  onSelect: (template: ChatVoteTemplate) => void;
}

const displayTitle = (template: ChatVoteTemplate, untitled: string): string => template.title.trim() || untitled;

export function ChatVoteTemplateList({
  templates,
  selectedId = null,
  vote,
  labels,
  durationText,
  onSelect,
}: ChatVoteTemplateListProperties): ReactElement {
  return <div className="chat-voting-template-list">
    {templates.map((template) => {
      const title = displayTitle(template, labels.untitled);
      const isRunning = (vote?.status === "open" || vote?.status === "closing") && template.lastUsedAt === vote.openedAt;
      const problem = templateStartProblem(template);
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
        action={null}
        selected={template.id === selectedId}
        status={isRunning ? <StatusLed state="ok" label={labels.running} /> : problem === null ? null : <span className="chat-voting-template-list__incomplete">{labels.incomplete}</span>}
      />;
    })}
  </div>;
}
