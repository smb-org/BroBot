import { UnitInput } from "../../../dashboard/ui";
import type { ModuleLanguage } from "../../contract";
import { pointsCatalog } from "../locale";

interface CreditPointsActionEditorProperties {
  config: Readonly<Record<string, unknown>>;
  onChange: (config: Readonly<Record<string, unknown>>) => void;
  language: ModuleLanguage;
}

export default function CreditPointsActionEditor({ config, onChange, language }: CreditPointsActionEditorProperties) {
  const copy = pointsCatalog[language].channelPointsActions;
  const amount = typeof config.amount === "number" && Number.isFinite(config.amount) ? config.amount : "";

  return <UnitInput
    label={copy.amountLabel}
    unit={copy.amountUnit}
    value={amount}
    min={1}
    max={1_000_000}
    required
    onChange={(next) => { onChange({ ...config, amount: next }); }}
  />;
}
