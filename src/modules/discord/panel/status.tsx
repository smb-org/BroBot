import type { ReactElement } from "react";

import { StatusLed, type StatusLedState } from "../../../dashboard/ui";
import { discordCatalog } from "../locale";
import type { DiscordServerConnectionState } from "../contracts";

const statusLedState: Readonly<Record<DiscordServerConnectionState, StatusLedState>> = {
  not_connected: "off",
  connected: "ok",
  bot_removed: "error",
  permissions_missing: "warn",
  role_too_low: "warn",
  could_not_check: "warn",
  not_available: "off",
};

const statusLabel = (state: DiscordServerConnectionState, language: "de" | "en"): string => {
  const text = discordCatalog[language];
  switch (state) {
    case "not_connected": return text.serverNotConnected;
    case "connected": return text.serverConnected;
    case "bot_removed": return text.botRemoved;
    case "permissions_missing": return text.permissionsMissing;
    case "role_too_low": return text.roleTooLow;
    case "could_not_check": return text.couldNotCheck;
    case "not_available": return text.serverNotAvailable;
  }
};

export function DiscordServerStatus({ state, language }: {
  state: DiscordServerConnectionState;
  language: "de" | "en";
}): ReactElement {
  return <div className="discord-server-panel__status" role="status" aria-live="polite" data-state={state}>
    <StatusLed state={statusLedState[state]} label={discordCatalog[language].serverSection} dotOnly />
    <span>{statusLabel(state, language)}</span>
  </div>;
}
