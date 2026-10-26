/** Maximum number of recent message ids retained by each realtime client. */
const REALTIME_MESSAGE_ID_LIMIT = 500;

/** Keeps duplicate detection bounded while retaining the newest message ids. */
export class RealtimeMessageIdCache {
  private readonly ids = new Map<string, true>();

  public has(id: string): boolean {
    return this.ids.has(id);
  }

  public add(id: string): void {
    if (this.ids.has(id)) return;
    this.ids.set(id, true);
    if (this.ids.size <= REALTIME_MESSAGE_ID_LIMIT) return;
    const oldest = this.ids.keys().next().value;
    if (oldest !== undefined) this.ids.delete(oldest);
  }
}
