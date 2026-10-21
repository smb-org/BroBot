import { Copy } from "lucide-react";
import type { KeyboardEvent, MouseEvent, ReactElement } from "react";

import { dashboardLanguage } from "../locale";
import { tokenChipTexts } from "../token-chip-locale";
import { notify } from "./toast-store";

export function TokenChip({ token, description }: { token: string; description?: string }): ReactElement {
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
      title={description === undefined ? texts.copyLabel(token) : `${texts.copyLabel(token)} — ${description}`}
      onClick={(event) => { void copy(event); }}
      onKeyDown={keepRowActionSeparate}
    >
      <code>{token}</code>
      <Copy aria-hidden="true" size={13} />
    </button>
  );
}
