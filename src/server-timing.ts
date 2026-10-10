import { schedulePanelResourceBackgroundWork } from "./worker/panel-resources";

export type ServerTimingPhase = "auth" | "d1" | "do" | "helix";
export type ServerTimingRecord = Record<ServerTimingPhase, number>;

declare module "hono" {
  interface ContextVariableMap {
    serverTiming: ServerTimingRecord;
  }
}

interface TimingContext {
  get: (key: "serverTiming") => ServerTimingRecord | undefined;
}

export const SERVER_TIMING_PHASES: readonly ServerTimingPhase[] = ["auth", "d1", "do", "helix"];

export const recordServerTiming = (
  context: Pick<TimingContext, "get">,
  phase: ServerTimingPhase,
  durationMs: number,
): void => {
  const timings = context.get("serverTiming");
  if (timings === undefined) return;
  timings[phase] += Math.max(0, durationMs);
};

export const measureServerTiming = async <T>(
  context: Pick<TimingContext, "get">,
  phase: ServerTimingPhase,
  run: () => Promise<T>,
): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    recordServerTiming(context, phase, performance.now() - startedAt);
  }
};

export const scheduleBackgroundWork = (
  context: {
    env: Pick<Env, "DB" | "CHANNEL">;
    executionCtx: { waitUntil: (promise: Promise<unknown>) => void };
  },
  work: Promise<unknown>,
): void => {
  void schedulePanelResourceBackgroundWork(
    context.env,
    work,
    () => context.executionCtx,
  );
};
