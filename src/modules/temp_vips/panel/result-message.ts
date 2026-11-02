import type { ModuleLanguage, ModuleTempVipResult } from "../../contract";

const dayMs = 24 * 60 * 60_000;

const expiryText = (value: string, language: ModuleLanguage, timeZone: string): string => {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(instant);
};

const allowedDuration = (milliseconds: number, language: ModuleLanguage): string => {
  const days = Math.floor(milliseconds / dayMs);
  if (days > 0) return language === "de" ? `${String(days)} Tage` : `${String(days)} days`;
  const minutes = Math.floor(milliseconds / 60_000);
  return language === "de" ? `${String(minutes)} Minuten` : `${String(minutes)} minutes`;
};

const rejectedReason = (reason: string | undefined, language: ModuleLanguage): string => {
  if (reason === "no_slots") return language === "de"
    ? "Auf Twitch sind keine VIP-Plätze frei. Entferne zuerst ein dauerhaftes VIP oder warte auf einen freien Platz."
    : "There are no free VIP slots on Twitch. Remove a permanent VIP first or wait for a slot to open.";
  if (reason === "moderator") return language === "de"
    ? "Das Konto ist Moderator:in und kann kein VIP sein. Wähle ein anderes Konto."
    : "This account is a moderator and cannot be a VIP. Choose another account.";
  if (reason === "community_gate") return language === "de"
    ? "Twitch erlaubt diese Vergabe derzeit nicht. Prüfe die Kanalvoraussetzungen und versuche es später erneut."
    : "Twitch does not allow this grant right now. Check the channel requirements and try again later.";
  if (reason === "already_vip") return language === "de"
    ? "Das Konto ist bereits VIP. Übernimm es über die VIP-Liste, wenn BroBot es verwalten soll."
    : "This account is already a VIP. Take it over from the VIP list if BroBot should manage it.";
  if (reason === "expiry_elapsed") return language === "de"
    ? "Die Ablaufzeit ist inzwischen vergangen. Wähle eine neue Ablaufzeit."
    : "The expiry time has passed. Choose a new expiry time.";
  if (reason === "not_connected" || reason === "scope_missing" || reason === "token_unavailable") return language === "de"
    ? "Die Broadcaster-Verbindung oder VIP-Berechtigung fehlt. Verbinde das Broadcaster-Konto erneut und erteile channel:manage:vips."
    : "The broadcaster connection or VIP permission is missing. Reconnect the broadcaster account and grant channel:manage:vips.";
  return language === "de"
    ? "Twitch hat die Aktion abgelehnt. Prüfe die VIP-Einstellungen und versuche es erneut."
    : "Twitch rejected the action. Check the VIP settings and try again.";
};

export const formatTempVipResult = (
  result: ModuleTempVipResult,
  language: ModuleLanguage,
  timeZone: string,
): string => {
  const expiry = result.expiresAt ?? result.row?.expiresAt;
  if (result.status === "granted" || result.status === "imported" || result.status === "extended") {
    const date = typeof expiry === "string" ? expiryText(expiry, language, timeZone) : null;
    if (result.status === "extended") return date === null
      ? language === "de" ? "VIP-Zeit wurde verlängert." : "VIP time was extended."
      : language === "de" ? `VIP-Zeit wurde verlängert · neues Ende ${date}.` : `VIP time extended · new end ${date}.`;
    if (result.status === "imported") return date === null
      ? language === "de" ? "Vorhandenes VIP wurde übernommen." : "Existing VIP taken over."
      : language === "de" ? `Vorhandenes VIP wurde übernommen · Ende ${date}.` : `Existing VIP taken over · ends ${date}.`;
    return date === null
      ? language === "de" ? "VIP wurde vergeben." : "VIP granted."
      : language === "de" ? `VIP wurde vergeben · Ende ${date}.` : `VIP granted · ends ${date}.`;
  }
  if (result.status === "queued" || result.status === "busy") return language === "de"
    ? "Die Aktion wartet in der Kanalwarteschlange. Warte auf das Ergebnis, bevor du sie erneut startest."
    : "The action is waiting in the channel queue. Wait for the result before starting it again.";
  if (result.status === "already_vip" || result.status === "already_managed") return rejectedReason("already_vip", language);
  if (result.status === "maximum_exceeded") {
    const allowed = result.allowedDurationMs === undefined ? null : allowedDuration(result.allowedDurationMs, language);
    if (allowed === null) return language === "de"
      ? "Die Höchstdauer würde überschritten. Wähle eine kürzere Dauer."
      : "This would exceed the maximum duration. Choose a shorter duration.";
    return language === "de"
      ? `Die Höchstdauer würde überschritten. Es sind noch ${allowed} möglich; wähle eine kürzere Dauer.`
      : `This would exceed the maximum duration. ${allowed} remain; choose a shorter duration.`;
  }
  if (result.status === "not_managed") return language === "de"
    ? "Der verwaltete Eintrag ist nicht mehr vorhanden. Aktualisiere die VIP-Liste und prüfe das Konto erneut."
    : "The managed entry is no longer present. Refresh the VIP list and check the account again.";
  if (result.status === "not_vip") return language === "de"
    ? "Dieses Konto ist auf Twitch kein VIP mehr. Aktualisiere die Auswahl und wähle ein aktuelles VIP."
    : "This account is no longer a VIP on Twitch. Refresh the selection and choose a current VIP.";
  if (result.status === "permanent_vip") return language === "de"
    ? "Dieser Eintrag ist dauerhaft eingestuft und kann nicht durch Vergeben, Verlängern oder Beenden per Chat geändert werden. Nutze die Einstufung im Dashboard."
    : "This entry is classified as permanent and cannot be changed by granting, extending, or ending it. Use the dashboard classification action.";
  if (result.status === "unclassified_vip") return language === "de"
    ? "Dieser Eintrag ist noch nicht eingestuft. Nutze zuerst eine Einstufung im Dashboard."
    : "This entry has not been classified yet. Classify it in the dashboard first.";
  if (result.status === "rejected") return rejectedReason(result.reason, language);
  if (result.status === "twitch_unavailable") return language === "de"
    ? "Twitch ist nicht erreichbar. Prüfe die Verbindung und versuche es erneut."
    : "Twitch is unavailable. Check the connection and try again.";
  return language === "de"
    ? "Die Aktion konnte nicht abgeschlossen werden. Aktualisiere die VIP-Liste, bevor du sie erneut startest."
    : "The action could not be completed. Refresh the VIP list before starting it again.";
};
