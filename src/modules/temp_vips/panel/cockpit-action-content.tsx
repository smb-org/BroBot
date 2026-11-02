import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Field, UnitInput } from "../../../dashboard/ui";
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

export default function TempVipsCockpitActionContent({ channelId, language, onDraftChange, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = tempVipsCockpitActionTexts[language];
  const [login, setLogin] = useState("");
  const [duration, setDuration] = useState<number | "">("");
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

  return <div className="live-action-content temp-vips-cockpit-content" aria-busy={!ready && !failed}>
    {/* eslint-disable-next-line no-restricted-syntax -- carries the channel time zone to the action as form data; there is no visible control. */}
    <input type="hidden" name="timeZone" value={timeZone} />
    <Field
      name="login"
      label={texts.login}
      value={login}
      onChange={(value) => { setLogin(value); onDraftChange?.(true); }}
      required
      autoComplete="off"
      spellCheck={false}
      placeholder="@pixelpilz"
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
  </div>;
}
