import type { ReactElement } from "react";

import { Field } from "./ui";

interface ChannelTimeZoneFieldProperties {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  canEdit: boolean;
  disabled: boolean;
}

export const ChannelTimeZoneField = ({ label, hint, value, onChange, canEdit, disabled }: ChannelTimeZoneFieldProperties): ReactElement => (
  <Field label={label} hint={hint} value={value} onChange={onChange} disabled={disabled} readOnly={!canEdit} />
);
