import { useEffect, useState, type ReactElement } from "react";

import type { DashboardLanguage } from "../../../dashboard/locale";
import { NumberField, SaveBar, Switch, useDraft } from "../../../dashboard/ui";
import type { RaidSettings } from "../contracts";
import { loadRaidSettings, saveRaidSettings } from "./service";
import { raidPanelTexts, type RaidPanelTexts } from "./locale";

interface RaidPanelProperties {
  channelId: string;
  language?: DashboardLanguage;
  canManage?: boolean;
}

type RaidPanelSettings = Omit<RaidSettings, "shoutoutThreshold" | "textThreshold"> & {
  shoutoutThreshold: number | "";
  textThreshold: number | "";
};

interface RaidFormProperties {
  channelId: string;
  labels: RaidPanelTexts;
  canManage: boolean;
  initial: RaidPanelSettings;
  /** Raises the just-saved value back to the caller, which feeds it back in
   *  as the next `initial` -- the draft and its new baseline then agree, so
   *  `dirty` clears without a remount and the one-shot "saved" status has a
   *  render to actually show in. */
  onSaved: (settings: RaidPanelSettings) => void;
}

const RaidForm = ({ channelId, labels, canManage, initial, onSaved }: RaidFormProperties): ReactElement => {
  const { value: settings, setValue: setSettings, dirty, reset } = useDraft<RaidPanelSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);
  const [numberErrors, setNumberErrors] = useState({ shoutoutThreshold: false, textThreshold: false });

  const disabled = !canManage || busy;
  const shoutoutThresholdDisabled = disabled || !settings.shoutoutEnabled;

  const change = (next: Partial<RaidPanelSettings>): void => {
    setSaved(false);
    setSettings((current) => ({ ...current, ...next }));
  };

  const save = async (): Promise<void> => {
    if (typeof settings.shoutoutThreshold !== "number" || typeof settings.textThreshold !== "number") {
      setNumberErrors({
        shoutoutThreshold: typeof settings.shoutoutThreshold !== "number",
        textThreshold: typeof settings.textThreshold !== "number",
      });
      return;
    }
    const shoutoutThreshold = settings.shoutoutThreshold;
    const textThreshold = settings.textThreshold;
    const savedSettings = { ...settings, shoutoutThreshold, textThreshold };
    setNumberErrors({ shoutoutThreshold: false, textThreshold: false });
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await saveRaidSettings(channelId, savedSettings);
      onSaved(savedSettings);
      setSaved(true);
    } catch {
      setError(labels.error);
    } finally {
      setBusy(false);
    }
  };

  const discard = (): void => {
    reset();
    setSaved(false);
    setNumberErrors({ shoutoutThreshold: false, textThreshold: false });
  };

  return (
    <section className="module-stack" aria-label={labels.title}>
      {!canManage ? <p className="lock-reason">{labels.managementLocked}</p> : null}
      <section className="config-section" aria-label={labels.thresholdSection}>
        <div className="section-heading"><h2>{labels.thresholdSection}</h2></div>
        <div style={{ display: "grid", gap: "6px", maxWidth: "var(--config-field-breit)" }}>
          <span>{labels.shoutoutEnabled}</span>
          <Switch
            ariaLabel={labels.toggleLabel(settings.shoutoutEnabled)}
            checked={settings.shoutoutEnabled}
            disabled={disabled}
            onChange={(checked) => { change({ shoutoutEnabled: checked }); }}
          />
        </div>
        <div className="config-field--schmal">
          <NumberField
            label={labels.shoutoutThreshold}
            value={settings.shoutoutThreshold}
            onChange={(value) => { setNumberErrors({ ...numberErrors, shoutoutThreshold: false }); change({ shoutoutThreshold: value }); }}
            min={0}
            max={100000}
            disabled={shoutoutThresholdDisabled}
            {...(numberErrors.shoutoutThreshold ? { error: labels.numberMissing } : {})}
          />
        </div>
        <div className="config-field--schmal">
          <NumberField
            label={labels.textThreshold}
            value={settings.textThreshold}
            onChange={(value) => { setNumberErrors({ ...numberErrors, textThreshold: false }); change({ textThreshold: value }); }}
            min={0}
            max={100000}
            disabled={disabled}
            {...(numberErrors.textThreshold ? { error: labels.numberMissing } : {})}
          />
        </div>
        <label className="config-field config-field--breit">
          {labels.fullText}
          <textarea
            aria-label={labels.fullText}
            value={settings.textLong}
            disabled={disabled}
            onChange={(event) => { change({ textLong: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.placeholderFull}</span>
        </label>
        <label className="config-field config-field--breit">
          {labels.shortText}
          <textarea
            aria-label={labels.shortText}
            value={settings.textShort}
            disabled={disabled}
            onChange={(event) => { change({ textShort: event.target.value }); }}
          />
          <span className="config-field__hint">{labels.placeholderShort}</span>
        </label>
      </section>
      <section className="config-section" aria-label={labels.actions}>
        <div className="section-heading"><h2>{labels.actions}</h2></div>
        <SaveBar
          dirty={dirty}
          pending={busy}
          {...(error !== undefined ? { error } : {})}
          saved={saved}
          onSave={() => { void save(); }}
          onDiscard={discard}
          saveLabel={labels.save}
          discardLabel={labels.discard}
          savedLabel={labels.saved}
          pendingLabel={labels.saving}
        />
      </section>
    </section>
  );
};

export const RaidPanel = ({
  channelId,
  language,
  canManage = true,
}: RaidPanelProperties): ReactElement => {
  const labels = raidPanelTexts(language);
  const [settings, setSettings] = useState<RaidPanelSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadRaidSettings(channelId).then((loaded) => {
      if (active) setSettings(loaded);
    }).catch(() => {
      if (active) setError(labels.error);
    });
    return () => { active = false; };
  }, [channelId, labels.error]);

  if (settings === null) return <p className="loading-line">{error ?? labels.load}</p>;

  return <RaidForm key={channelId} channelId={channelId} labels={labels} canManage={canManage} initial={settings} onSaved={setSettings} />;
};

export default RaidPanel;
