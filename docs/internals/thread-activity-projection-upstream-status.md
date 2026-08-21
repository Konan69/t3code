# Thread activity projection: upstream status

Checked against the official `pingdotgg/t3code` repository on 2026-08-21.

## Verdict

The measured server read-amplification and client stable-ID update regressions
remain in shipped nightly
[`v0.0.34-nightly.20260821.1151`](https://github.com/pingdotgg/t3code/tree/v0.0.34-nightly.20260821.1151)
(`be7d35aa`). Fetched `origin/main` was the same commit.

Upstream has added other useful activity-retention and WSL sidecar work since
the previous `.1093` check, but it does not contain the local server fast path
or indexed client reducer.

## Evidence

At `be7d35aa`, the server still groups every `thread.activity-appended` with
events that call `refreshThreadShellSummary`. That refresh reads the full
message, plan, activity, and approval history to derive a small shell summary.

The client still handles every activity event by:

1. filtering the full activity array;
2. appending the incoming row; and
3. sorting the full result.

This happens even when a progress event replaces a row with the same stable ID.
The source tree contains neither `activityAffectsShellSummary` nor the local
`activityById` weak index.

Relevant shipped sources:

- [server projection pipeline](https://github.com/pingdotgg/t3code/blob/be7d35aa/apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
- [client thread reducer](https://github.com/pingdotgg/t3code/blob/be7d35aa/packages/client-runtime/src/state/threadReducer.ts)

## Local overlay

The rebased local commits are:

| Commit     | Scope                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------- |
| `1d8e2946` | Incrementally updates the shell row and refreshes only for approval/user-input activity kinds |
| `1898c035` | Adds a per-array activity ID index and binary insertion path                                  |
| `7bdd63bd` | Uses the append fast path only for reducer-produced sorted arrays                             |
| `c211c471` | Replaces same-ID activities incrementally and suppresses equivalent redelivery                |

Historical PRs [#6608](https://github.com/pingdotgg/t3code/pull/6608) and
[#6613](https://github.com/pingdotgg/t3code/pull/6613) contain related work,
but their relevant hot-path behavior was not present in `.1151`/`be7d35aa`.
