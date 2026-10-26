import { PanelApiError } from "../../../contracts/panel-error";
import type { BossFightLiveTileRound } from "./live-tile";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const loadBossFightRound = async (channelId: string, signal: AbortSignal): Promise<BossFightLiveTileRound | null> => {
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/boss_fight/round`, { signal });
  if (!response.ok) throw new PanelApiError(response.status, "boss_fight_round_unavailable");
  const value: unknown = await response.json();
  const round = record(record(value)?.round);
  if (round === null || typeof round.id !== "string" || !Number.isSafeInteger(round.currentHp) ||
      !Number.isSafeInteger(round.maxHp) || !Number.isSafeInteger(round.attackers) ||
      typeof round.closesAt !== "string") return null;
  return round as unknown as BossFightLiveTileRound;
};

export const startBossFightNow = async (channelId: string): Promise<void> => {
  const tokenResponse = await fetch("/api/csrf");
  const tokenBody: unknown = await tokenResponse.json().catch(() => null);
  const token = record(tokenBody)?.token;
  if (typeof token !== "string") throw new Error("csrf_unavailable");
  const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/boss_fight/start`, {
    method: "POST",
    headers: { "X-CSRF-Token": token },
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof record(result)?.error === "string" ? record(result)?.error as string : "round_start_failed");
};
