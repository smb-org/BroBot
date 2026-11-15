import { createPortal } from "react-dom";
import { useRef, useState, type ReactElement } from "react";

import { Button, TwitchUserField, type TwitchUserFieldHandle } from "../../../dashboard/ui";
import type { ModuleImmediateActionContentProperties, PanelTwitchUser } from "../../contract";
import { raidActionContentTexts } from "./action-content-locale";

export default function ShoutoutActionContent({ channelId, language, onDraftChange, onActionExecute, footerElement }: ModuleImmediateActionContentProperties): ReactElement {
  const [user, setUser] = useState<PanelTwitchUser | null>(null);
  const [login, setLogin] = useState("");
  const [resolving, setResolving] = useState(false);
  const userField = useRef<TwitchUserFieldHandle>(null);

  const execute = async (): Promise<void> => {
    if (resolving || onActionExecute === undefined) return;
    const form = footerElement?.closest("form");
    if (form === null || form === undefined || !form.reportValidity()) return;
    setResolving(true);
    try {
      const resolved = await userField.current?.resolve() ?? null;
      if (resolved === null) return;
      const formData = new FormData(form);
      formData.set("userId", resolved.userId);
      formData.set("login", resolved.login);
      formData.set("displayName", resolved.displayName);
      await onActionExecute(formData);
    } finally {
      setResolving(false);
    }
  };

  return <>
    <div className="live-action-content">
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch ID to the action as form data. */}
    <input type="hidden" name="userId" value={user?.userId ?? ""} />
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch login to the action as form data. */}
    <input type="hidden" name="login" value={user?.login ?? ""} />
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch display name to the action as form data. */}
    <input type="hidden" name="displayName" value={user?.displayName ?? ""} />
    <TwitchUserField
      ref={userField}
      channelId={channelId}
      label={raidActionContentTexts.channelName[language]}
      hint={raidActionContentTexts.channelHint[language]}
      value={user}
      onChange={(value) => { setUser(value); onDraftChange?.(true); }}
      onLoginChange={(value) => { setLogin(value); if (value.length > 0) onDraftChange?.(true); }}
      required
      showLiveBadge
      placeholder="beispielkanal"
    />
    </div>
    {footerElement === null || footerElement === undefined ? null : createPortal(
      <Button variant="primary" type="button" disabled={login.length === 0 || resolving || onActionExecute === undefined} onClick={() => { void execute(); }}>
        {resolving ? raidActionContentTexts.running[language] : raidActionContentTexts.run[language]}
      </Button>,
      footerElement,
    )}
  </>;
}
