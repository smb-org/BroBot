import type { ReactElement } from "react";

import { FieldPair } from "./FieldPair";
import { UnitInput } from "./UnitInput";

export interface TimeoutDurationRangeValue {
  minSeconds: number | "";
  maxSeconds: number | "";
}

export interface TimeoutDurationRangeFieldsProperties {
  value: TimeoutDurationRangeValue;
  onChange: (value: TimeoutDurationRangeValue) => void;
  min: number;
  max: number;
  minimumLabel: string;
  maximumLabel: string;
  hint: string;
  unit?: string;
  disabled?: boolean;
  error?: string;
  showLabels?: boolean;
  idPrefix: string;
}

/** The shared fixed-or-random timeout duration editor. */
export function TimeoutDurationRangeFields({
  value, onChange, min, max, minimumLabel, maximumLabel, hint, showLabels = false,
  unit = "s", disabled = false, error, idPrefix,
}: TimeoutDurationRangeFieldsProperties): ReactElement {
  const fields = <FieldPair>
    <UnitInput
      id={`${idPrefix}-minimum`} label={minimumLabel} hint={hint} unit={unit}
      min={min} max={max} step={1} value={value.minSeconds}
      disabled={disabled} {...(error === undefined ? {} : { error })}
      onChange={(minSeconds) => onChange({ ...value, minSeconds })}
    />
    <UnitInput
      id={`${idPrefix}-maximum`} label={maximumLabel} hint={hint} unit={unit}
      min={min} max={max} step={1} value={value.maxSeconds}
      disabled={disabled} {...(error === undefined ? {} : { error })}
      onChange={(maxSeconds) => onChange({ ...value, maxSeconds })}
    />
  </FieldPair>;
  return showLabels ? <div className="timeout-duration-range-fields timeout-duration-range-fields--visible-labels">{fields}</div> : fields;
}
