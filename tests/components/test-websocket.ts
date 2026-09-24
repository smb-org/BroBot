export class TestWebSocket {
  public static instances: TestWebSocket[] = [];
  public readonly listeners = new Map<string, Set<EventListener>>();
  public protocol = "brobot.v1";

  public constructor(public readonly url = "", public readonly protocols?: string | string[]) {
    TestWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(typeof listener === "function" ? listener : (event) => {
      listener.handleEvent(event);
    });
    this.listeners.set(type, listeners);
  }

  public close(code = 1000): void {
    this.dispatch("close", { code, reason: "closed" } as CloseEvent);
  }

  public dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
