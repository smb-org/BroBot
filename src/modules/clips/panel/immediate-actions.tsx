import { useState, type ReactElement } from "react";

import { Button, Icon, notify } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { clipsActionTexts } from "./locale";
import { createClip } from "./service";

const ClipAction = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";
  const labels = clipsActionTexts(language);
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ message: string; editUrl: string | null } | null>(null);
  const availabilityReasonId = "stream-manager-clips-availability-reason";

  const run = async (): Promise<void> => {
    if (pending || availabilityReason !== null) return;
    setPending(true);
    setOutcome(null);
    try {
      const result = await createClip(channelId);
      setOutcome({ message: labels.created, editUrl: result.editUrl });
      notify({ tone: "success", message: labels.created });
    } catch {
      setOutcome({ message: labels.failed, editUrl: null });
      notify({ tone: "error", message: labels.failed });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="stream-manager-action">
      <div className="stream-manager-action__header"><Icon name="clip" size={20} /><h3>{labels.title}</h3></div>
      <Button className="stream-manager-action__button" icon="clip" variant="primary" disabled={pending || availabilityReason !== null} {...(availabilityReason !== null ? { describedBy: availabilityReasonId } : {})} onClick={() => { void run(); }}>
        {labels.create}
      </Button>
      <p className="lock-reason" id={availabilityReasonId} data-testid="immediate-action-result-slot"
        style={{ height: "var(--s6)", overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", margin: 0 }} aria-live="polite"
        title={availabilityReason ?? outcome?.message}>
        {availabilityReason ?? (outcome === null ? "" : <>{outcome.message}{outcome.editUrl === null ? null : <> <a href={outcome.editUrl} target="_blank" rel="noreferrer" aria-label={`${labels.open} (${labels.opensNewTab})`}>{labels.open}<Icon name="external" size={16} /></a></>}</>)}
      </p>
    </div>
  );
};

export default ClipAction;
