import { createHmac } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { eventSubRouter } from "../../src/worker/eventsub";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { TestD1Database } from "./test-d1";

vi.mock("../../src/worker/dispatch", () => ({
  dispatchEventSubNotification: vi.fn(),
}));

const secretKey = Buffer.from(new Uint8Array(32).fill(3)).toString("base64url");
const secret = JSON.stringify({ active: { id: "eventsub-v1", key: secretKey }, retired: [] });

const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return {
    promise,
    resolve: (value) => {
      if (complete === undefined) throw new Error("The deferred promise was not initialized.");
      complete(value);
    },
  };
};

const signedChatNotification = (messageId: string): Request => {
  const timestamp = new Date().toISOString();
  const body = JSON.stringify({
    subscription: {
      type: "channel.chat.message",
      condition: { broadcaster_user_id: "channel-a" },
    },
    event: { message_id: "chat-message-a", message: { text: "!clip" } },
  });
  const signature = createHmac("sha256", Buffer.from(secretKey, "ascii"))
    .update(`${messageId}${timestamp}${body}`, "utf8")
    .digest("hex");
  return new Request("https://brobot.example/api/twitch/eventsub", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": "notification",
    },
  });
};

describe("EventSub awaited dispatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("awaits normal dispatch for clip chat syntax and keeps duplicate deliveries deduplicated", async () => {
    const database = new TestD1Database();
    const confirmation = deferred<undefined>();
    vi.mocked(dispatchEventSubNotification).mockReturnValue(confirmation.promise);
    const waitUntil = vi.fn();
    const executionContext = {
      waitUntil: (promise: Promise<unknown>): void => { waitUntil(promise); },
    } as unknown as ExecutionContext;
    const environment = {
      DB: database as unknown as D1Database,
      TWITCH_EVENTSUB_SECRET: secret,
    } as unknown as Env;

    const request = signedChatNotification("clip-confirmation-pending");
    const responsePromise = Promise.resolve(eventSubRouter.fetch(request, environment, executionContext));
    const acknowledgedBeforeDispatch = await Promise.race([
      responsePromise.then(() => true),
      new Promise<boolean>((resolve) => { window.setTimeout(() => { resolve(false); }, 25); }),
    ]);

    const duplicate = await eventSubRouter.fetch(
      signedChatNotification("clip-confirmation-pending"),
      environment,
      executionContext,
    );
    const recorded = await database.prepare(
      "SELECT message_id FROM eventsub_messages WHERE message_id = ?",
    ).bind("clip-confirmation-pending").first<{ message_id: string }>();
    confirmation.resolve(undefined);
    const response = await responsePromise;

    expect(acknowledgedBeforeDispatch).toBe(false);
    expect(response.status).toBe(204);
    expect(duplicate.status).toBe(204);
    expect(recorded).toEqual({ message_id: "clip-confirmation-pending" });
    expect(vi.mocked(dispatchEventSubNotification)).toHaveBeenCalledTimes(1);
    expect(waitUntil).not.toHaveBeenCalled();
    database.close();
  });
});
