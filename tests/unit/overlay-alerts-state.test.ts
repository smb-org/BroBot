import { describe, expect, it } from "vitest";

import {
  advanceOverlayAlertQueue,
  emptyOverlayAlertQueueState,
  enqueueOverlayAlert,
  overlayAlertStateForBootstrap,
  parseOverlayAlertConfig,
  parseOverlayAlertPayload,
  renderOverlayAlertText,
} from "../../src/modules/overlay_alerts/overlay/state";

const startedAt = Date.parse("2030-01-01T12:00:00.000Z");

const alert = (operationId: string, durationSeconds = 2) => ({
  operationId,
  text: operationId,
  durationSeconds,
  volumePercent: 80,
});

describe("overlay alerts state", () => {
  it("plays queued alerts sequentially without overlapping their time ranges", () => {
    const first = enqueueOverlayAlert(emptyOverlayAlertQueueState(startedAt), alert("first"), startedAt, true).state;
    const queued = enqueueOverlayAlert(first, alert("second"), startedAt + 500, true).state;

    expect(queued.current).toMatchObject({
      operationId: "first",
      startedAt: new Date(startedAt).toISOString(),
      endsAt: new Date(startedAt + 2_000).toISOString(),
    });
    expect(queued.queue.map(({ operationId }) => operationId)).toEqual(["second"]);
    expect(advanceOverlayAlertQueue(queued, startedAt + 1_999, true).current?.operationId).toBe("first");

    const next = advanceOverlayAlertQueue(queued, startedAt + 2_000, true);

    expect(next.current).toMatchObject({
      operationId: "second",
      startedAt: new Date(startedAt + 2_000).toISOString(),
      endsAt: new Date(startedAt + 4_000).toISOString(),
    });
    expect(next.queue).toHaveLength(0);
  });

  it("does not replay a finished alert at reconnect and retains pending alerts", () => {
    const first = enqueueOverlayAlert(emptyOverlayAlertQueueState(startedAt), alert("finished"), startedAt, true).state;
    const queued = enqueueOverlayAlert(first, alert("waiting"), startedAt + 500, true).state;

    const bootstrap = overlayAlertStateForBootstrap(queued, startedAt + 2_001);

    expect(bootstrap.current).toBeNull();
    expect(bootstrap.queue.map(({ operationId }) => operationId)).toEqual(["waiting"]);
    expect(advanceOverlayAlertQueue(bootstrap, startedAt + 2_001, true).current?.operationId).toBe("waiting");
  });

  it("retains waiting alerts when the current alert expires while disconnected", () => {
    const first = enqueueOverlayAlert(emptyOverlayAlertQueueState(startedAt), alert("finished"), startedAt, true).state;
    const queued = enqueueOverlayAlert(first, alert("waiting"), startedAt + 500, true).state;

    const offline = advanceOverlayAlertQueue(queued, startedAt + 2_001, false);

    expect(offline.current).toBeNull();
    expect(offline.queue.map(({ operationId }) => operationId)).toEqual(["waiting"]);
    expect(advanceOverlayAlertQueue(offline, startedAt + 2_002, true).current?.operationId).toBe("waiting");
  });

  it("does not enqueue the same operation id more than once", () => {
    const first = enqueueOverlayAlert(emptyOverlayAlertQueueState(startedAt), alert("redemption"), startedAt, true);
    const replay = enqueueOverlayAlert(first.state, alert("redemption"), startedAt + 100, true);

    expect(first.outcome).toBe("enqueued");
    expect(replay.outcome).toBe("duplicate");
    expect(replay.state).toBe(first.state);
    expect(replay.state.queue).toHaveLength(0);
  });

  it("enforces overlay style bounds and duration bounds", () => {
    expect(parseOverlayAlertConfig({ textColor: "#ffffff", fontSize: 32 })).toEqual({ textColor: "#ffffff", fontSize: 32 });
    expect(parseOverlayAlertConfig({ textColor: "<red>", fontSize: 1000 })).toBeNull();
    expect(parseOverlayAlertConfig({ textColor: "#ffffff", fontSize: 32, extra: true })).toBeNull();
    const payload = { operationId: "test", text: "Hi", durationSeconds: 2, volumePercent: 80 };
    expect(parseOverlayAlertPayload(payload)).not.toBeNull();
    expect(parseOverlayAlertPayload({ ...payload, durationSeconds: 15 })).not.toBeNull();
    expect(parseOverlayAlertPayload({ ...payload, durationSeconds: 1 })).toBeNull();
    expect(parseOverlayAlertPayload({ ...payload, durationSeconds: 16 })).toBeNull();
    expect(parseOverlayAlertPayload({ ...payload, volumePercent: 101 })).toBeNull();
  });

  it("renders viewer placeholders as plain text and caps the rendered result", () => {
    const rendered = renderOverlayAlertText("{user}: {input} · {reward}", {
      userName: "Viewer",
      userLogin: "viewer_login",
      userInput: "<script>alert(1)</script>",
      rewardTitle: "Welcome",
    });

    expect(rendered).toBe("Viewer: <script>alert(1)</script> · Welcome");
    expect(renderOverlayAlertText("{input}".repeat(80), {
      userName: "Viewer",
      userLogin: "viewer_login",
      userInput: "x".repeat(300),
      rewardTitle: "Welcome",
    })).toHaveLength(200);
  });
});
