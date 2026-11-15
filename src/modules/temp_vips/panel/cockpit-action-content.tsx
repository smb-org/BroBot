import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties, PanelTwitchUser } from "../../contract";
import { Button, TwitchUserField, UnitInput, type TwitchUserFieldHandle } from "../../../dashboard/ui";
import {
  loadTempVips,
  tempVipActionReadinessForMode,
  type TempVipActionReadiness,
  type TempVipsPanelData,
} from "./service";
import { tempVipsCockpitActionTexts } from "./action-locale";

interface SettingsLoadState {
  channelId: string;
  settings: TempVipsPanelData["settings"] | null;
  timeZone: string;
  permission: TempVipActionReadiness | null;
  failed: boolean;
}

export default function TempVipsCockpitActionContent({ channelId, language, onDraftChange, onReadinessChange, onActionExecute, footerElement }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = tempVipsCockpitActionTexts[language];
  const [person, setPerson] = useState<PanelTwitchUser | null>(null);
  const [login, setLogin] = useState("");
  const [duration, setDuration] = useState<number | "">("");
  const [resolving, setResolving] = useState(false);
  const userField = useRef<TwitchUserFieldHandle>(null);
  const [state, setState] = useState<SettingsLoadState>({ channelId, settings: null, timeZone: "UTC", permission: null, failed: false });
  const settings = state.channelId === channelId ? state.settings : null;
  const permission = state.channelId === channelId ? state.permission : null;
  const timeZone = state.channelId === channelId ? state.timeZone : "UTC";
  const failed = state.channelId === channelId && state.failed;

  useEffect(() => {
    const controller = new AbortController();
    void loadTempVips(channelId, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      const permissionState = tempVipActionReadinessForMode(data.mode);
      setDuration(Math.min(data.settings.defaultDurationDays, data.settings.maximumDurationDays));
      setState({ channelId, settings: data.settings, timeZone: data.timeZone, permission: permissionState, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ channelId, settings: null, timeZone: "UTC", permission: null, failed: true });
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const ready = settings !== null && permission?.ready === true && !failed;
  const reason = failed ? texts.loadFailed : permission?.metadataUnknown === true
    ? texts.scopeCheckFailed : permission !== null && !permission.ready ? texts.scopeMissing : ready ? null : texts.loading;
  useEffect(() => { onReadinessChange?.(ready, reason); }, [onReadinessChange, reason, ready]);

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
    <div className="live-action-content temp-vips-cockpit-content" aria-busy={!ready && !failed}>
    {/* eslint-disable-next-line no-restricted-syntax -- carries the channel time zone to the action as form data; there is no visible control. */}
    <input type="hidden" name="timeZone" value={timeZone} />
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch ID to the action as form data. */}
    <input type="hidden" name="userId" value={person?.userId ?? ""} />
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch login to the action as form data. */}
    <input type="hidden" name="login" value={person?.login ?? ""} />
    {/* eslint-disable-next-line no-restricted-syntax -- carries the resolved Twitch display name to the action as form data. */}
    <input type="hidden" name="displayName" value={person?.displayName ?? ""} />
    <TwitchUserField
      ref={userField}
      channelId={channelId}
      label={texts.login}
      hint={texts.loginHint}
      value={person}
      onChange={(value) => { setPerson(value); onDraftChange?.(true); }}
      onLoginChange={(value) => { setLogin(value); if (value.length > 0) onDraftChange?.(true); }}
      required
      placeholder="chatfreund"
      disabled={!ready}
    />
    <UnitInput
      name="durationDays"
      label={texts.duration}
      unit={language === "de" ? "Tage" : "days"}
      value={duration}
      min={1}
      max={settings?.maximumDurationDays ?? 90}
      onChange={(value) => { setDuration(value); onDraftChange?.(true); }}
      hint={texts.durationHint}
      required
      disabled={!ready}
    />
    {reason !== null && reason !== texts.loading ? <p className="live-action-content__status" role="alert">{reason}</p> : null}
    </div>
    {footerElement === null || footerElement === undefined ? null : createPortal(
      <Button variant="primary" type="button" disabled={!ready || login.length === 0 || resolving || onActionExecute === undefined} onClick={() => { void execute(); }}>
        {resolving ? texts.running : texts.run}
      </Button>,
      footerElement,
    )}
  </>;
}
