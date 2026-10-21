import type { ReactElement } from "react";

import { ListRow } from "../../../dashboard/ui";
import type { ChatVoteTemplate } from "../contracts";
import { templateStartProblem } from "../domain";

interface ChatVoteTemplateListLabels {
  untitled: string;
  incomplete: string;
  shortcutMeta: (shortcut: string) => string;
  templateMeta: (answerCount: number, duration: string) => string;
  cockpitOffer: string;
  chatOnly: string;
}

export interface ChatVoteTemplateListProperties {
  templates: readonly ChatVoteTemplate[];
  selectedId?: string | null;
  labels: ChatVoteTemplateListLabels;
  durationText: (seconds: number) => string;
  onSelect: (template: ChatVoteTemplate) => void;
}

export function ChatVoteTemplateList({ templates, selectedId = null, labels, durationText, onSelect }: ChatVoteTemplateListProperties): ReactElement {
  return <div className="chat-voting-template-list">
    {templates.map((template) => {
      const title = template.title.trim() || labels.untitled;
      const problem = templateStartProblem(template);
      const description = <span>
        {template.shortcut === null ? null : <><span className="mono">{labels.shortcutMeta(template.shortcut)}</span> · </>}
        {labels.templateMeta(template.freeTextMode === null ? template.labels.length : 0, durationText(template.durationSeconds))} · <span className="chat-voting-template-list__offer">{template.offerInCockpit ? labels.cockpitOffer : labels.chatOnly}</span>
      </span>;
      return <ListRow
        key={template.id}
        href={`#${encodeURIComponent(template.id)}`}
        onNavigate={() => { onSelect(template); }}
        title={title}
        description={description}
        action={null}
        selected={template.id === selectedId}
        status={problem === null ? null : <span className="chat-voting-template-list__incomplete">{labels.incomplete}</span>}
      />;
    })}
  </div>;
}
