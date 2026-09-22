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
 */
export class PanelApiError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = "PanelApiError";
  }
}
