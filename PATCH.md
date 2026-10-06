# T3 Code Cloudbox overlay

`local/boat` tracks upstream through `4fb04fe7f` (2026-10-06; app version 0.0.45, orchestrator protocol 2, Effect 4.0.1). Merge `47004a882` adopts upstream orchestrator V2 and its provider implementations.

## Retained overlay

- Cloudbox host lifecycle and wake contracts, relay endpoints, server host lifecycle configuration, and desktop wake IPC. Shared connection logic consumes explicit wake intent once and runs wake in the background: scope rejection, missing routes, failures, and pending wake requests cannot gate ordinary authorization. These APIs require a relay that implements them; production `relay.t3.codes` currently does not.
- Thread machines use V2 project mode and thread metadata/events. Legacy bindings import into V2 and survive projection replay. Launch preparation creates the dedicated workspace, starts the machine, and runs setup inside it. Archive stops the machine; deletion removes the worktree and destroys machine resources through V2's durable cleanup queue.
- Codex, Claude, and upstream Pi launch inside bound machines. Pi's upstream permission/MCP extension cache is mounted read-only. Cursor, Grok, OpenCode 2, and Antigravity V2 drivers explicitly reject machine-bound sessions until their runtime launch boundaries are ported; ordinary host sessions retain upstream behavior.
- WSL hardening: native ext4 staging, isolated shell startup, content-addressed runtime handling, IPv4 discovery from the default route (avoids Docker interfaces), and Windows loopback selection when WSL uses mirrored networking.
- Fork SSH releases download versioned Linux archives and `SHA256SUMS` from `https://github.com/Konan69/t3code/releases/download/v$VERSION/`, without fallback to upstream releases.
- The staged installer disables the stock updater so upstream nightlies cannot replace the fork installation.

## Superseded overlay and UI handoff

Upstream owns orchestration, provider switching, subagents, persistence shapes, and Pi. The fork Pi driver/adapter, MCP extension, Pi queue fixes, legacy provider fixes, and old orchestration reactors were removed. Machine routing is a small integration with upstream V2 adapters; there is one Pi implementation.

Web/mobile conflict files were taken verbatim from upstream. Claude owns restoring fork UI behavior: Cloudbox status/wake controls and queued-work recovery, thread machine defaults and indicators, offline-action wake handling, and provider presentation. Backend work does not modify web/mobile UI or the BranchToolbar components. UI integration must finish before rebuilding or pushing.

## Migration compatibility

Upstream migrations 055 (`OrchestrationV2`) and 056 (`RemoveRedundantProjectionIndexes`) precede the fork migrations below. Keep these ids and names unchanged:

```text
900 ProjectionMachineBindings
901 ProjectionMachineProjectWorkspaceRoot
902 RepairProjectionProjectsAutoPull
```

The runner tracks names in `t3_fork_migrations`, orders pending entries by id, and bootstraps the old ledger without rewriting it. An existing fork with 900–902 applied still runs newly introduced lower upstream ids. Migration 055 preserves an existing fork project machine mode when creating its V2 event baseline.

## Updating the installed build

After frontend integration and verification, build and stage with `~/t3code-staging/rebuild-boat.sh` and the merged app version in `~/t3code-staging/boat/version`. The `t3-apply-boat` systemd waiter logs to `~/t3code-staging/apply-boat.log` and installs once the user exits T3 Code; it never closes or restarts the app. The installer backs up replaced resources as `*.pre-overlay-<UTC>`, swaps the staged files, and disables the stock updater. `apply-boat.sh --rollback` waits the same way and restores the newest backup.

### Updates shown in the app

With no update feed the stock updater is off. `apps/desktop/src/updates/LocalStagedUpdate.ts` makes the staging pipeline the update source instead: `status.sh` copies its status to `%LOCALAPPDATA%\\t3code-updater\\status.json` (phase, version, commit, notes), and `DesktopUpdates` polls that file, so the sidebar pill and Settings show a build in progress, a staged build with what it adds, or "up to date". Its install action quits the app, which is what `apply-boat.sh` waits for. The mode is on only when that directory exists and `app-update.yml` names no provider.

The Boat box keeps its own server under `~/.t3/runtime/versions/<version>`, keyed by version only. `rebuild-boat.sh` uploads the new archive (`seed-boat-runtime.sh --upload`) and `apply-boat.sh` switches the box to it after the install (`--activate`).

## Design skills

The fork vendors a curated design skill stack in `.agents/skills/` (Emil Kowalski's set, the `better-*` family, `interface-review`, `break-ui`). `AGENTS.md` ends with the "Design stack (UI work)" section that fixes the order to use them in. Both are fork-only; keep them when merging upstream.
