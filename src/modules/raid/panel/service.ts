import type { RaidSettings } from "../contracts";
import { PanelApiError } from "../../../contracts/panel-error";
import type { PanelTemplateWarning, PanelTemplateWarningResponse } from "../contract";

const pathFor = (channelId: string): string =>
  `/api/channels/${encodeURIComponent(channelId)}/modules/raid/settings`;

const json = async <T>(response: Response): Promise<T> => {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new PanelApiError(
    response.status,
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : null,
    body,
  );
  return body as T;
};

export const loadRaidSettings = async (channelId: string): Promise<RaidSettings> => {
  const response = await fetch(pathFor(channelId));
  return (await json<{ settings: RaidSettings }>(response)).settings;
};

export const saveRaidSettings = async (
  channelId: string,
  settings: RaidSettings,
): Promise<readonly PanelTemplateWarning[]> => {
  const csrfResponse = await fetch("/api/csrf");
  const csrf = await json<{ token: string }>(csrfResponse);
  const saved = await json<PanelTemplateWarningResponse>(await fetch(pathFor(channelId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.token },
    body: JSON.stringify(settings),
  }));
  return saved.warnings;
};
