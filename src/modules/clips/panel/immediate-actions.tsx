import { useState, type ReactElement } from "react";

import { Button, Icon } from "../../../dashboard/ui";
import type { ModuleImmediateActionProperties } from "../contract";
import { clipsActionTexts } from "./locale";
import { createClip } from "./service";

const ClipAction = ({ channelId, availabilityReason }: ModuleImmediateActionProperties): ReactElement => {
  const language = typeof navigator === "undefined" || !navigator.language.toLowerCase().startsWith("en") ? "de" : "en";
  const labels = clipsActionTexts(language);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const [editUrl, setEditUrl] = useState<string | null>(null);
  const availabilityReasonId = "stream-manager-clips-availability-reason";

  const run = async (): Promise<void> => {
    if (pending || availabilityReason !== null) return;
    setPending(true);
    setMessage(null);
    setSucceeded(false);
    setEditUrl(null);
    try {
      const result = await createClip(channelId);
      setEditUrl(result.editUrl);
      setMessage(labels.created);
      setSucceeded(true);
    } catch {
      setMessage(labels.failed);
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
      {availabilityReason === null ? null : <p className="lock-reason" id={availabilityReasonId}>{availabilityReason}</p>}
      {message === null ? null : (
        <p className={succeeded ? "form-success" : "form-error"} role={succeeded ? "status" : "alert"}>
          <span>{message}</span>{editUrl === null ? null : <> · <a href={editUrl} target="_blank" rel="noreferrer" aria-label={`${labels.open} (${labels.opensNewTab})`}>{labels.open}<Icon name="external" size={16} /></a></>}
        </p>
      )}
    </div>
  );
};

export default ClipAction;
