import { useEffect, useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { Field, UnitInput } from "../../../dashboard/ui";
import { loadTempVips, type TempVipsPanelData } from "./service";
import { tempVipsCockpitActionTexts } from "./action-locale";

interface SettingsLoadState {
  channelId: string;
  settings: TempVipsPanelData["settings"] | null;
  failed: boolean;
}

export default function TempVipsCockpitActionContent({ channelId, language, onDraftChange, onReadinessChange }: ModuleImmediateActionContentProperties): ReactElement {
  const texts = tempVipsCockpitActionTexts[language];
  const [login, setLogin] = useState("");
  const [duration, setDuration] = useState<number | "">("");
  const [state, setState] = useState<SettingsLoadState>({ channelId, settings: null, failed: false });
  const settings = state.channelId === channelId ? state.settings : null;
  const failed = state.channelId === channelId && state.failed;

  useEffect(() => {
    const controller = new AbortController();
    void loadTempVips(channelId, controller.signal).then((data) => {
      if (controller.signal.aborted) return;
      setDuration(Math.min(data.settings.defaultDurationDays, data.settings.maximumDurationDays));
      setState({ channelId, settings: data.settings, failed: false });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ channelId, settings: null, failed: true });
    });
    return () => { controller.abort(); };
  }, [channelId]);

  const ready = settings !== null && !failed;
  const reason = ready ? null : failed ? texts.loadFailed : texts.loading;
  useEffect(() => { onReadinessChange?.(ready, reason); }, [onReadinessChange, reason, ready]);

  return <div className="live-action-content temp-vips-cockpit-content" aria-busy={!ready && !failed}>
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
    {failed ? <p className="live-action-content__status" role="alert">{texts.loadFailed}</p> : null}
  </div>;
}
