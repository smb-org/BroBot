import type { ReactElement } from "react";

import { FieldPair } from "./FieldPair";
import { NumberField } from "./NumberField";

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
  idPrefix: string;
}

/** The shared fixed-or-random timeout duration editor. */
export function TimeoutDurationRangeFields({
  value, onChange, min, max, minimumLabel, maximumLabel, hint,
  unit = "s", disabled = false, error, idPrefix,
}: TimeoutDurationRangeFieldsProperties): ReactElement {
  return <FieldPair>
    <NumberField
      id={`${idPrefix}-minimum`} label={minimumLabel} hint={hint} unit={unit}
      min={min} max={max} step={1} value={value.minSeconds}
      increaseLabel={`${minimumLabel} +`} decreaseLabel={`${minimumLabel} −`}
      disabled={disabled} {...(error === undefined ? {} : { error })}
      onChange={(minSeconds) => onChange({ ...value, minSeconds })}
    />
    <NumberField
      id={`${idPrefix}-maximum`} label={maximumLabel} hint={hint} unit={unit}
      min={min} max={max} step={1} value={value.maxSeconds}
      increaseLabel={`${maximumLabel} +`} decreaseLabel={`${maximumLabel} −`}
      disabled={disabled} {...(error === undefined ? {} : { error })}
      onChange={(maxSeconds) => onChange({ ...value, maxSeconds })}
    />
  </FieldPair>;
}
