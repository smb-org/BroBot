export interface BossHealthInput {
  baseHp: number;
  hpPerAttacker: number;
  attackers: number;
  damageDealt: number;
}

export interface BossDamageShare {
  accountId: string;
  login: string;
  damage: number;
}

export interface BossPayout extends BossDamageShare {
  amount: number;
}

export const rollBossDamage = (
  minimum: number,
  maximum: number,
  random: () => number = Math.random,
): number => {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum < 1 || maximum < minimum ||
      !Number.isSafeInteger(maximum - minimum + 1)) throw new Error("invalid_boss_damage_range");
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error("invalid_random_value");
  return minimum + Math.floor(value * (maximum - minimum + 1));
};

export const bossHealth = ({ baseHp, hpPerAttacker, attackers, damageDealt }: BossHealthInput): {
  maxHp: number;
  currentHp: number;
  defeated: boolean;
} => {
  if (!Number.isSafeInteger(baseHp) || baseHp < 1 || !Number.isSafeInteger(hpPerAttacker) || hpPerAttacker < 0 ||
      !Number.isSafeInteger(attackers) || attackers < 0 || !Number.isSafeInteger(damageDealt) || damageDealt < 0) {
    throw new Error("invalid_boss_health");
  }
  const scaledHp = baseHp + hpPerAttacker * attackers;
  if (!Number.isSafeInteger(scaledHp)) throw new Error("invalid_boss_health");
  const maxHp = Math.max(scaledHp, damageDealt);
  return { maxHp, currentHp: Math.max(0, maxHp - damageDealt), defeated: damageDealt > 0 && damageDealt >= maxHp };
};

export const calculateBossPayouts = (lootPool: number, participants: readonly BossDamageShare[]): {
  totalDamage: number;
  distributed: number;
  payouts: BossPayout[];
} => {
  if (!Number.isSafeInteger(lootPool) || lootPool < 0) throw new Error("invalid_boss_loot");
  const accounts = new Set<string>();
  let totalDamage = 0n;
  for (const participant of participants) {
    if (participant.accountId.length === 0 || participant.login.length === 0 || !Number.isSafeInteger(participant.damage) || participant.damage < 0 ||
        accounts.has(participant.accountId)) throw new Error("invalid_boss_damage");
    accounts.add(participant.accountId);
    totalDamage += BigInt(participant.damage);
  }
  if (totalDamage > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid_boss_damage");
  const payouts = participants.map((participant) => ({
    ...participant,
    amount: totalDamage === 0n ? 0 : Number(BigInt(lootPool) * BigInt(participant.damage) / totalDamage),
  }));
  const distributed = payouts.reduce((sum, payout) => sum + payout.amount, 0);
  return { totalDamage: Number(totalDamage), distributed, payouts };
};
