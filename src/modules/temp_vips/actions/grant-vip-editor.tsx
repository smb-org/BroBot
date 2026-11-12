import { UnitInput } from "../../../dashboard/ui";
import type { ModuleLanguage } from "../../contract";
import { DEFAULT_TEMP_VIPS_SETTINGS } from "../contracts";
import { tempVipsChannelPointsActionTexts } from "../locale";

interface GrantVipActionEditorProperties {
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  language: ModuleLanguage;
}

export default function GrantVipActionEditor({ config, onChange, language }: GrantVipActionEditorProperties) {
  const copy = tempVipsChannelPointsActionTexts[language];
  const duration = typeof config.durationDays === "number" && Number.isFinite(config.durationDays)
    ? config.durationDays
    : DEFAULT_TEMP_VIPS_SETTINGS.defaultDurationDays;

  return <UnitInput
    label={copy.durationLabel}
    unit={copy.durationUnit}
    value={duration}
    min={1}
    max={90}
    required
    onChange={(next) => { onChange({ ...config, durationDays: next }); }}
  />;
}
