import { Copy } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";

import { dashboardLanguage } from "../locale";
import { tokenChipTexts } from "../token-chip-locale";
import { notify } from "./toast-store";

export function TokenChip({ token }: { token: string }): ReactElement {
  const texts = tokenChipTexts[dashboardLanguage()];
  const copy = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(token);
      notify({ tone: "success", message: texts.copied });
    } catch {
      notify({ tone: "error", message: texts.copyFailed });
    }
  };
  const keepRowActionSeparate = (event: KeyboardEvent<HTMLButtonElement>): void => { event.stopPropagation(); };

  return (
    <button
      type="button"
      data-ui="token-chip"
      className="ui-token-chip"
      aria-label={texts.copyLabel(token)}
      title={texts.copyLabel(token)}
      onClick={(event) => { void copy(event); }}
      onKeyDown={keepRowActionSeparate}
    >
      <code>{token}</code>
      <Copy aria-hidden="true" size={13} />
    </button>
  );
}
