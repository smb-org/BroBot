import { describe, expect, it } from "vitest";

import {
  advanceAlert,
  createInitialAlertState,
  settleAlertChat,
  type BelaboxAlertSettings,
} from "../../src/modules/belabox/domain/alert";

type RelaySample = { at: string; connected: boolean; bitrateKbps: number };

const settings: BelaboxAlertSettings = {
  alertsEnabled: true,
  lowBitrateKbps: 1_000,
  recoverBitrateKbps: 2_000,
  holdSeconds: 10,
  recoverHoldSeconds: 15,
  chatCooldownSeconds: 300,
  chatEnabled: true,
};

const sample = (second: number, bitrateKbps = 3_000, connected = true): RelaySample => ({
  at: new Date(Date.UTC(2026, 9, 5, 12, 0, second)).toISOString(),
  bitrateKbps,
  connected,
});

const enterLowAlarm = () => {
  const first = advanceAlert(createInitialAlertState(), sample(0, 900), settings, Date.UTC(2026, 9, 5, 12, 0, 0));
  return advanceAlert(first.state, sample(10, 900), settings, Date.UTC(2026, 9, 5, 12, 0, 10));
};

describe("BELABOX alert state machine", () => {
  it("moves from ok through pending to alarm after sample timestamps meet the hold", () => {
    const pending = advanceAlert(createInitialAlertState(), sample(0, 900), settings, 300_000);
    const stillPending = advanceAlert(pending.state, sample(9, 900), settings, 1_000);
    const delayed = advanceAlert(stillPending.state, sample(12, 900), settings, 2_000);

    expect(pending.state).toMatchObject({ phase: "pending", kind: "low", since: sample(0).at });
    expect(delayed.state).toMatchObject({ phase: "alarm", kind: "low", episodeStartedAt: sample(0).at });
    expect(delayed.outputs).toMatchObject({ phaseChange: { code: "belabox.alert_started" }, chat: { kind: "low", idempotencyKind: "alert" } });
  });

  it("holds a disconnected encoder before starting a disconnect episode", () => {
    const pending = advanceAlert(createInitialAlertState(), sample(0, 0, false), settings, 0);
    const alarm = advanceAlert(pending.state, sample(10, 0, false), settings, 10_000);

    expect(pending.state).toMatchObject({ phase: "pending", kind: "disconnect" });
    expect(alarm.state).toMatchObject({ phase: "alarm", kind: "disconnect" });
    expect(alarm.outputs.phaseChange).toMatchObject({ code: "belabox.alert_started", detail: { kind: "disconnect" } });
  });

  it("cancels a pending low bitrate alarm when bitrate returns above the low threshold", () => {
    const pending = advanceAlert(createInitialAlertState(), sample(0, 900), settings, 0);
    const cancelled = advanceAlert(pending.state, sample(5, 1_000), settings, 5_000);

    expect(cancelled.state).toMatchObject({ phase: "ok", kind: null });
    expect(cancelled.outputs).toEqual({ phaseChange: null, chat: null });
  });

  it("escalates a low bitrate alarm when the encoder disconnects", () => {
    const lowAlarm = enterLowAlarm();
    const escalated = advanceAlert(lowAlarm.state, sample(11, 0, false), settings, 11_000);

    expect(escalated.state).toMatchObject({ phase: "alarm", kind: "disconnect", episodeStartedAt: sample(0).at });
    expect(escalated.outputs).toMatchObject({ phaseChange: { code: "belabox.alert_escalated" }, chat: { kind: "disconnect", idempotencyKind: "escalate" } });
  });

  it("moves an alarm through recovering to ok and only queues recovery after a sent alert", () => {
    const lowAlarm = enterLowAlarm();
    const sent = settleAlertChat(lowAlarm.state, { sent: true, retryable: false }, Date.UTC(2026, 9, 5, 12, 0, 10));
    const recovering = advanceAlert(sent, sample(11, 2_000), settings, 11_000);
    const recovered = advanceAlert(recovering.state, sample(26, 2_100), settings, 26_000);

    expect(recovering.state).toMatchObject({ phase: "recovering", kind: "low", episodeStartedAt: sample(0).at });
    expect(recovered.state).toMatchObject({ phase: "ok", kind: null, completedEpisodeAt: sample(0).at });
    expect(recovered.outputs).toMatchObject({ phaseChange: { code: "belabox.alert_recovered" }, chat: { kind: "recovery", idempotencyKind: "recovered" } });

    const droppedAlert = settleAlertChat(lowAlarm.state, { sent: false, retryable: false }, 10_000);
    const unsentRecovering = advanceAlert(droppedAlert, sample(11, 2_000), settings, 11_000);
    const unsentRecovery = advanceAlert(unsentRecovering.state, sample(26, 2_100), settings, 26_000);
    expect(unsentRecovery.outputs.chat).toBeNull();
  });

  it("keeps a relapse in the same alarm episode without another alert", () => {
    const lowAlarm = enterLowAlarm();
    const sent = settleAlertChat(lowAlarm.state, { sent: true, retryable: false }, 10_000);
    const recovering = advanceAlert(sent, sample(11, 2_100), settings, 11_000);
    const relapse = advanceAlert(recovering.state, sample(16, 900), settings, 16_000);

    expect(relapse.state).toMatchObject({ phase: "alarm", kind: "low", episodeStartedAt: sample(0).at });
    expect(relapse.outputs).toEqual({ phaseChange: null, chat: null });
  });

  it("keeps the hysteresis band from changing the current phase", () => {
    const lowAlarm = enterLowAlarm();
    const sent = settleAlertChat(lowAlarm.state, { sent: true, retryable: false }, 10_000);
    const bandSample = advanceAlert(sent, sample(11, 1_500), settings, 11_000);

    expect(bandSample.state).toEqual(sent);
    expect(bandSample.outputs).toEqual({ phaseChange: null, chat: null });
  });

  it.each([
    {
      name: "drops below the recovery threshold",
      relaySample: sample(26, 1_500),
      kind: "low",
      diagnostic: null,
      chatKind: "alert",
    },
    {
      name: "disconnects during recovery",
      relaySample: sample(26, 0, false),
      kind: "disconnect",
      diagnostic: { code: "belabox.alert_escalated", detail: { kind: "disconnect", threshold: 0, seconds: settings.holdSeconds } },
      chatKind: "escalate",
    },
  ] as const)("returns to alarm when recovery $name", ({ relaySample, kind, diagnostic, chatKind }) => {
    const lowAlarm = enterLowAlarm();
    const recovering = advanceAlert(lowAlarm.state, sample(11, 2_100), settings, 11_000);
    const next = advanceAlert(recovering.state, relaySample, settings, Date.parse(relaySample.at));

    expect(next.state).toMatchObject({ phase: "alarm", kind, episodeStartedAt: sample(0).at });
    expect(next.outputs.phaseChange).toEqual(diagnostic);
    expect(next.outputs.chat).toMatchObject({ idempotencyKind: chatKind });
    expect(next.state.pendingChat).toEqual(next.outputs.chat);
  });

  it("restarts the recovery hold after a sample drops below the recovery threshold", () => {
    const lowAlarm = enterLowAlarm();
    const sent = settleAlertChat(lowAlarm.state, { sent: true, retryable: false }, 10_000);
    const recovering = advanceAlert(sent, sample(11, 2_100), settings, 11_000);
    const returnedToAlarm = advanceAlert(recovering.state, sample(20, 1_500), settings, 20_000);
    const restarted = advanceAlert(returnedToAlarm.state, sample(21, 2_100), settings, 21_000);
    const heldForFourteenSeconds = advanceAlert(restarted.state, sample(35, 2_100), settings, 35_000);
    const recovered = advanceAlert(heldForFourteenSeconds.state, sample(36, 2_100), settings, 36_000);

    expect(returnedToAlarm.state.phase).toBe("alarm");
    expect(restarted.state).toMatchObject({ phase: "recovering", since: sample(21, 2_100).at });
    expect(heldForFourteenSeconds.state.phase).toBe("recovering");
    expect(recovered.state.phase).toBe("ok");
    expect(recovered.outputs.phaseChange?.code).toBe("belabox.alert_recovered");
  });

  it("holds alert chat output until its cooldown expires", () => {
    const lowAlarm = enterLowAlarm();
    const sent = settleAlertChat(lowAlarm.state, { sent: true, retryable: false }, Date.UTC(2026, 9, 5, 12, 0, 10));
    const recovering = advanceAlert(sent, sample(11, 2_100), settings, Date.UTC(2026, 9, 5, 12, 0, 11));
    const recovered = advanceAlert(recovering.state, sample(26, 2_100), settings, Date.UTC(2026, 9, 5, 12, 0, 26));
    const nextEpisodeStart = advanceAlert(recovered.state, sample(27, 900), settings, Date.UTC(2026, 9, 5, 12, 0, 27));
    const nextEpisode = advanceAlert(nextEpisodeStart.state, sample(37, 900), settings, Date.UTC(2026, 9, 5, 12, 0, 37));

    expect(recovered.outputs.chat).toMatchObject({ idempotencyKind: "recovered" });
    expect(nextEpisode.outputs.chat).toBeNull();
    const afterCooldown = advanceAlert(nextEpisode.state, sample(38, 900), settings, Date.UTC(2026, 9, 5, 12, 5, 10));
    expect(afterCooldown.outputs.chat).toMatchObject({ idempotencyKind: "alert" });
  });

  it("does not trigger chat for a fetch failure and retries a retryable send on a later successful sample", () => {
    const lowAlarm = enterLowAlarm();
    const retryable = settleAlertChat(lowAlarm.state, { sent: false, retryable: true }, 12_000);
    const failed = advanceAlert(retryable, { kind: "fetch_error", at: sample(11).at, reason: "network" }, settings, 13_000);
    const recoveredFetch = advanceAlert(failed.state, sample(12, 900), settings, 14_000);

    expect(failed.state).toEqual(retryable);
    expect(failed.outputs.chat).toBeNull();
    expect(recoveredFetch.outputs.chat).toMatchObject({ idempotencyKind: "alert" });
  });

  it("resets on stream.offline without diagnostics or chat", () => {
    const lowAlarm = enterLowAlarm();
    const offline = advanceAlert(lowAlarm.state, { kind: "stream_offline" }, settings, 12_000);

    expect(offline.state).toEqual(createInitialAlertState());
    expect(offline.outputs).toEqual({ phaseChange: null, chat: null });
  });

  it.each([false, true])("records a sent chat when retryable is %s", (retryable) => {
    const lowAlarm = enterLowAlarm();
    const pending = settleAlertChat(lowAlarm.state, { sent: false, retryable: true }, 11_000);
    const sent = settleAlertChat(pending, { sent: true, retryable }, 12_000);

    expect(pending.pendingChat).toEqual(lowAlarm.state.pendingChat);
    expect(sent).toMatchObject({ chatSentInEpisode: true, pendingChat: null, lastChatSentAt: new Date(12_000).toISOString() });
    expect(lowAlarm.state.chatSentInEpisode).toBe(false);
  });
});
