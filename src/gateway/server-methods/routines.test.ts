import { afterEach, describe, expect, it, vi } from "vitest";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { routinesHandlers } from "./routines.js";

function createCronJob(input: CronJobCreate, nowMs: number): CronJob {
  return {
    ...input,
    id: input.id ?? "cron-1",
    enabled: input.enabled ?? true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    state: {},
  };
}

function createRoutineContext() {
  const jobs = new Map<string, CronJob>();
  const cron = {
    list: vi.fn(async () => [...jobs.values()]),
    add: vi.fn(async (input: CronJobCreate) => {
      const job = createCronJob(input, Date.now());
      jobs.set(job.id, job);
      return job;
    }),
    readJob: vi.fn(async (id: string) => jobs.get(id)),
    getDefaultAgentId: vi.fn(() => "main"),
  };
  return {
    cron,
    cronStorePath: "/tmp/cron.sqlite",
    getRuntimeConfig: () => ({}),
    logGateway: { info: vi.fn() },
  };
}

function routineCreateParams(at: string) {
  return {
    id: "one-shot-briefing",
    name: "One-shot briefing",
    trigger: { kind: "schedule", schedule: { kind: "at", at } },
    target: { sessionTarget: "isolated", wakeMode: "now" },
    action: { kind: "agentTurn", message: "Review the queue." },
  };
}

async function invokeRoutineCreate(context: ReturnType<typeof createRoutineContext>, at: string) {
  const respond = vi.fn();
  await routinesHandlers["routines.create"]({
    req: {} as never,
    params: routineCreateParams(at) as never,
    respond: respond as never,
    context: context as never,
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("routines gateway methods", () => {
  it("allows idempotent create replay after a one-shot schedule has passed", async () => {
    await withOpenClawTestState({ prefix: "gateway-routine-replay-" }, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const context = createRoutineContext();
      const at = new Date("2026-01-01T00:02:00Z").toISOString();

      const first = await invokeRoutineCreate(context, at);
      expect(first.mock.calls[0]?.[0]).toBe(true);
      expect(first.mock.calls[0]?.[1]).toMatchObject({ created: true, idempotent: false });

      vi.setSystemTime(new Date("2026-01-01T00:04:00Z"));
      const replay = await invokeRoutineCreate(context, at);

      expect(replay.mock.calls[0]?.[0]).toBe(true);
      expect(replay.mock.calls[0]?.[1]).toMatchObject({ created: false, idempotent: true });
      expect(context.cron.add).toHaveBeenCalledTimes(1);
    });
  });
});
