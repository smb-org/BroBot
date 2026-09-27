const CURRENCY_CACHE_TTL_MS = 15 * 60 * 1_000;

interface CurrencyCacheRow {
  rate: number;
  expires_at: string;
  etag: string | null;
}

const expiryFromHeaders = (headers: Headers, now: number): number => {
  const expiresHeader = headers.get("Expires");
  const expiresAt = expiresHeader === null ? Number.NaN : Date.parse(expiresHeader);
  const maxAge = /(?:^|,)\s*max-age=(\d+)/iu.exec(headers.get("Cache-Control") ?? "")?.[1];
  const providerExpiry = Number.isFinite(expiresAt) ? expiresAt : maxAge === undefined ? null : now + Number(maxAge) * 1_000;
  return providerExpiry === null ? now + CURRENCY_CACHE_TTL_MS : Math.min(now + CURRENCY_CACHE_TTL_MS, Math.max(now, providerExpiry));
};

export const exchangeRate = async (
  db: D1Database,
  baseCurrency: string,
  targetCurrency: string,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<number> => {
  const base = baseCurrency.toUpperCase();
  const target = targetCurrency.toUpperCase();
  const cached = await db.prepare(
    `SELECT rate, expires_at, etag FROM currency_rate_cache WHERE base_currency = ? AND target_currency = ?`,
  ).bind(base, target).first<CurrencyCacheRow>();
  const expiration = cached === null ? Number.NaN : Date.parse(cached.expires_at);
  if (cached !== null && Number.isFinite(cached.rate) && expiration > now) return cached.rate;

  const url = new URL(`https://api.frankfurter.dev/v1/latest`);
  url.searchParams.set("base", base);
  url.searchParams.set("symbols", target);
  const headers = new Headers({ Accept: "application/json" });
  if (cached?.etag !== null && cached?.etag !== undefined) headers.set("If-None-Match", cached.etag);
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(5_000) });
  const expiresAt = expiryFromHeaders(response.headers, now);
  if (response.status === 304 && cached !== null && Number.isFinite(cached.rate)) {
    await db.prepare(
      `UPDATE currency_rate_cache SET expires_at = ?, etag = ?, updated_at = ? WHERE base_currency = ? AND target_currency = ?`,
    ).bind(new Date(expiresAt).toISOString(), response.headers.get("ETag") ?? cached.etag, new Date(now).toISOString(), base, target).run();
    return cached.rate;
  }
  if (!response.ok) throw new Error(`Frankfurter returned HTTP ${String(response.status)}.`);
  const payload: unknown = await response.json().catch(() => null);
  const payloadRecord = typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const rates = payloadRecord?.rates;
  const ratesRecord = typeof rates === "object" && rates !== null && !Array.isArray(rates)
    ? rates as Record<string, unknown>
    : null;
  const rate = ratesRecord?.[target];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
    throw new Error("Frankfurter response did not include a valid exchange rate.");
  }
  await db.prepare(
    `INSERT INTO currency_rate_cache (base_currency, target_currency, rate, expires_at, etag, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(base_currency, target_currency) DO UPDATE SET rate = excluded.rate,
       expires_at = excluded.expires_at, etag = excluded.etag, updated_at = excluded.updated_at`,
  ).bind(base, target, rate, new Date(expiresAt).toISOString(), response.headers.get("ETag"), new Date(now).toISOString()).run();
  return rate;
};
