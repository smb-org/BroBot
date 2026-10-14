import { useState, type ReactElement } from "react";

import type { ModuleImmediateActionContentProperties } from "../../contract";
import { SegmentChoice } from "../../../dashboard/ui";
import { adsActionContentTexts } from "./action-content-locale";

const LENGTHS = ["30", "60", "90", "120", "150", "180"] as const;

export default function AdActionContent({ language, onDraftChange }: ModuleImmediateActionContentProperties): ReactElement {
  const [length, setLength] = useState<(typeof LENGTHS)[number]>("60");

  return <div className="live-action-content">
    <SegmentChoice
      label={adsActionContentTexts.length[language]}
      hint={adsActionContentTexts.lengthHint[language]}
      name="length"
      value={length}
      onChange={(value) => { setLength(value); onDraftChange?.(true); }}
      options={LENGTHS.map((value) => ({ value, label: `${value}s`, compactLabel: value }))}
      size="compact"
    />
  </div>;
}
