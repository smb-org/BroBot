import type {
  HelixErrorReason,
  HelixRequest,
  HelixRequestOptions,
  HelixResult,
} from "../../modules/contract";

export type {
  HelixErrorReason,
  HelixMethod,
  HelixRequest,
  HelixRequestOptions,
  HelixResult,
} from "../../modules/contract";

const DEFAULT_TIMEOUT_MS = 5_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

const messageOf = (body: unknown): string | null =>
  isRecord(body) && typeof body.message === "string" && body.message.length > 0 ? body.message : null;

/**
 * Thin transport over `api.twitch.tv/helix` (issue #163): headers, a
 * timeout, tolerant JSON reading and base error classification. It does not
 * acquire tokens (`accessToken` is opaque to it), retry, sleep on 429, keep
 * state, or interpret what a status *means* for a given endpoint -- a 401 on
 * snooze is a missing scope, on shoutout it's "bot isn't a moderator here",
 * and 404-on-delete is often success. That reading stays with the caller.
 * The four `id.twitch.tv` token endpoints (form-encoded, `OAuth`-prefixed,
 * no Client-ID) are a different shape entirely and stay standalone.
 */
export const helixRequest: HelixRequest = async <Data = unknown>(
  options: HelixRequestOptions<Data>,
): Promise<HelixResult<Data>> => {
  const url = new URL(options.url);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const init: RequestInit = {
    headers: {
      "Client-ID": options.clientId,
      Authorization: `Bearer ${options.accessToken}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    signal: controller.signal,
  };
  if (options.method !== undefined) init.method = options.method;
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  // A manual `setTimeout` race, not a bare `signal: AbortSignal.timeout(...)`:
  // the request still carries an abort signal (so a cooperating `fetch`
  // cancels the underlying connection), but the call also resolves on its
  // own if the fetcher never looks at the signal at all -- true of some test
  // doubles, and the reason this can't be Twitch's problem to solve either.
  let response: Response;
  try {
    const fetcher = options.fetcher ?? fetch;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(Object.assign(new Error("The Helix request timed out."), { name: "TimeoutError" }));
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    });
    try {
      response = await Promise.race([fetcher(url.toString(), init), timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  } catch (error: unknown) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return { ok: false, status: null, reason: timedOut ? "timeout" : "network_error", message: null, body: {} };
  }

  const rawBody = await readJson(response);
  const body = isRecord(rawBody) ? rawBody : {};
  if (!response.ok) {
    const reason: HelixErrorReason = response.status === 429 ? "rate_limited" : `http_${String(response.status)}`;
    return { ok: false, status: response.status, reason, message: messageOf(body), body };
  }

  if (options.schema === undefined) {
    return { ok: true, status: response.status, data: rawBody as Data };
  }
  const parsed = options.schema.safeParse(rawBody);
  if (!parsed.success) {
    return { ok: false, status: response.status, reason: "invalid_response", message: null, body };
  }
  return { ok: true, status: response.status, data: parsed.data };
};

interface HelixPage<Item> {
  data: readonly Item[];
  pagination?: { cursor?: string };
}

/** Follows Twitch's cursor pagination, guarding against a repeated cursor. */
export const helixPages = async <Item>(
  fetchPage: (cursor: string | null) => Promise<HelixResult<HelixPage<Item>>>,
): Promise<HelixResult<Item[]>> => {
  const items: Item[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    if (!page.ok) return page;
    items.push(...page.data.data);
    const next = page.data.pagination?.cursor;
    if (next === undefined || next.length === 0) return { ok: true, status: page.status, data: items };
    if (seenCursors.has(next)) {
      return {
        ok: false,
        status: page.status,
        reason: "pagination_loop",
        message: "Twitch returned a repeated pagination cursor.",
        body: {},
      };
    }
    seenCursors.add(next);
    cursor = next;
  }
};
