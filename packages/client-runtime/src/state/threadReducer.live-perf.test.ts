import { expect, it } from "vite-plus/test";

import { applyThreadDetailEvent } from "./threadReducer.ts";

// Mirrors the activity count of the production thread that exposed the
// stable-id streaming regression.
const activityCount = 20_192;
const threadId = "thread-live-perf";
const turnId = "turn-live-perf";

const activities = Array.from({ length: activityCount }, (_, index) => ({
  id: `activity-${index}`,
  tone: "tool",
  kind: index === activityCount - 1 ? "context-window.updated" : "tool.completed",
  summary: "activity",
  payload: index === activityCount - 1 ? { usedTokens: index } : { index },
  turnId,
  sequence: index + 1,
  createdAt: `2026-08-14T18:00:${String(index % 60).padStart(2, "0")}.000Z`,
}));

const baseThread = {
  id: threadId,
  projectId: "project-live-perf",
  title: "Live reducer performance replay",
  modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-08-14T18:00:00.000Z",
  updatedAt: "2026-08-14T18:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities,
  checkpoints: [],
  session: null,
} as any;

const makeProgressEvent = (index: number, payloadVersion: number) =>
  ({
    eventId: `event-${index}`,
    sequence: activityCount + index + 1,
    occurredAt: `2026-08-14T18:30:${String(index % 60).padStart(2, "0")}.000Z`,
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: {
      threadId,
      activity: {
        id: "task-progress:live-thread:stable-item",
        tone: "info",
        kind: "task.progress",
        summary: "Streaming progress",
        payload: { text: `progress-${payloadVersion}` },
        turnId,
        createdAt: `2026-08-14T18:31:${String(index % 60).padStart(2, "0")}.000Z`,
      },
    },
  }) as any;

it("updates a stable progress activity within the streaming budget", () => {
  let current = baseThread;
  const first = applyThreadDetailEvent(current, makeProgressEvent(1, 1));
  expect(first.kind).toBe("updated");
  if (first.kind !== "updated") return;
  current = first.thread;

  const samples: number[] = [];
  for (let index = 2; index <= 51; index += 1) {
    const startedAt = performance.now();
    const result = applyThreadDetailEvent(current, makeProgressEvent(index, index));
    samples.push(performance.now() - startedAt);
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") return;
    current = result.thread;
  }

  const sorted = [...samples].sort((left, right) => left - right);
  const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)] ?? Infinity;
  expect(p95).toBeLessThan(2);
  expect(
    current.activities.filter(
      (activity: { id: string }) => activity.id === "task-progress:live-thread:stable-item",
    ),
  ).toHaveLength(1);
  expect(current.activities.at(-1)?.payload).toEqual({ text: "progress-51" });
});

it("does not rerender for an identical progress redelivery", () => {
  const first = applyThreadDetailEvent(baseThread, makeProgressEvent(1, 1));
  expect(first.kind).toBe("updated");
  if (first.kind !== "updated") return;

  const duplicate = applyThreadDetailEvent(first.thread, makeProgressEvent(1, 1));
  expect(duplicate.kind).toBe("unchanged");
});
