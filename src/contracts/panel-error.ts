/**
 * Fehler einer Panel-Anfrage samt HTTP-Status.
 *
 * Liegt in `contracts/`, weil Dashboard **und** Module ihn brauchen: Das Dashboard
 * erkennt eine abgelaufene Sitzung am Status 401, und die Modul-Panels müssen ihn
 * dorthin weiterreichen können. In `dashboard/` wäre er für Module unerreichbar —
 * die Modulgrenze in `eslint.config.js` lässt dorthin nur `dashboard/locale` durch.
 *
 * Die Alternative wäre gewesen, `dashboard/api` für Module freizugeben. Das hätte
 * ihnen den Zugriff auf die gesamte Panel-Schnittstelle geöffnet statt auf diesen
 * einen Vertrag.
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
