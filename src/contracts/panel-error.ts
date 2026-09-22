/**
 * Error from a panel request, including the HTTP status.
 *
 * Lives in `contracts/` because both the dashboard **and** modules need it: the
 * dashboard recognizes an expired session by status 401, and the module panels
 * need to be able to pass it on to there. In `dashboard/` it would be unreachable
 * for modules — the module boundary in `eslint.config.js` only lets `dashboard/locale`
 * through to there.
 *
 * The alternative would have been to expose `dashboard/api` to modules. That would
 * have opened up access to the entire panel interface for them, instead of just
 * this one contract.
 *
 * `code` carries the server's `{ "error": "<code>" }` value verbatim, or the
 * one the dashboard's own request guard raised client-side. It is `string |
 * null` rather than `ApiErrorCode | null`: a response can come from an old
 * worker, a proxy's HTML error page, or fail to parse as JSON at all, and
 * none of those are a type error at this boundary. `dashboard/locale.ts`'s
 * `apiErrorText` is what checks the code against the closed catalogue and
 * falls back to a generic text when it doesn't recognize it.
 */
export class PanelApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string | null,
    public readonly details: unknown = null,
  ) {
    super(code ?? "request_failed");
    this.name = "PanelApiError";
  }
}
