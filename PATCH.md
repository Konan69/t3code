# T3 Code local Windows/WSL patch overlay

## Current build — 2026-08-26

- Official shell/tag: `v0.0.35-nightly.20260826.1194`
- Upstream `origin/main`: `a3a8cbd6` (identical to the shipped tag when fetched)
- Local branch: `local/main-20260826-nightly-1194-patched`
- Pre-rebase backup branch:
  `backup/pre-1194-rebase-20260826` (old head `adab47ef`, base `be7d35aa`)
- Previous installed state: official `.1194` (the release had replaced the
  `.1151` overlay before this rebase)

Automatic T3 Code updates replace the overlay. After each official update,
rebase onto the new tag, rebuild, and rerun the installer script.

## Rebase audit — what was dropped

Every manifest commit was checked against upstream `be7d35aa..a3a8cbd6`
(100 commits). None of the functional patches were absorbed:

| Area                                                                           | Upstream signal                    | Verdict     |
| ------------------------------------------------------------------------------ | ---------------------------------- | ----------- |
| WSL ext4 staging                                                               | no `wsl-runtime` in upstream       | keep        |
| Preview cookie set IPC                                                         | upstream added `clearCookies` only | keep        |
| Activity append/index perf                                                     | no equivalent commits              | keep        |
| Settings hydration race                                                        | not fixed upstream                 | keep        |
| Docs-only history (`5058cc41`, `317e69e7`, `deb7d2f9`, `c4cf4ac2`, `2abc39ff`) | superseded by this file            | **dropped** |

One tooling regression from dropping docs history was caught and fixed: the
local installer script `scripts/install-local-windows-bundle.cjs` used to
travel inside a docs commit; it is restored as explicit tooling.

## Patch set

| Area                    | Commits (new hashes)               | Result                                                                                                                                                 |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WSL startup             | `d0871926`, `ec50fea7`             | Native-ext4 runtime staging, 60-second probe, isolated non-login shell, stable Codex cwd, mirrored-network loopback                                    |
| Preview cookies         | `5aedee97`, `bd56186d`             | Typed cookie IPC/tool/UI; cookie writes skip unrelated preview-session sync                                                                            |
| Server activity writes  | `d3f43128`                         | Streaming/tool activity no longer reloads entire thread history to rebuild its shell summary (upstream added its own refresh gate; both gates coexist) |
| Client activity updates | `e66bb95e`, `c5090bc3`, `91e874d0` | Indexed append/replacement path; stable-ID progress updates stop filtering and sorting full activity history                                           |
| Provider settings       | `e77c558e`                         | Acquires the settings PubSub subscription before forking its watcher                                                                                   |
| Regression tests        | `f09e724b`                         | Local test reconciliation; must travel with the code                                                                                                   |
| Packaging tooling       | `fa57c241`                         | Restores `scripts/install-local-windows-bundle.cjs` with dedicated `server.asar` support                                                               |
| pi provider             | `86c88f24`                         | Native `pi --mode rpc` driver (see below)                                                                                                              |

### Complete reapply manifest

Apply every entry below, in order, after rebasing onto a new official
release. This is the authoritative code/test/tooling patch list.

```text
d0871926 fix(desktop): stabilize WSL startup
5aedee97 feat(preview): add cookie setting
bd56186d fix(preview): cookie writes skip session sync
ec50fea7 fix(desktop): isolate WSL backend shell
d3f43128 perf: make streaming projection and activity appends incremental
e66bb95e perf: index activity ids so streamed appends stop rescanning history
c5090bc3 fix: gate the activity append fast path on reducer-produced ordering
91e874d0 perf(client): update stable activities incrementally
e77c558e fix(server): subscribe before provider settings hydration
f09e724b test: reconcile local regressions with nightly 1151
fa57c241 chore(desktop): restore local Windows bundle installer
86c88f24 feat(provider): add native pi driver over pi --mode rpc
```

Note for future rebases: `20d1459a` (server-archive installer support) is now
part of `fa57c241`; upstream deleted nothing it depended on, but the script
itself remains local-only tooling.

## pi provider driver

`86c88f24` adds a first-class `pi` provider alongside Codex/Claude/Cursor/
Grok/OpenCode. One `pi --mode rpc` child per thread, strict LF JSONL framing,
id-correlated command Deferreds, canonical runtime event mapping (content
deltas, tool lifecycle, usage, compaction, retry warnings, turn settle/abort).
Enable via Settings → Providers → pi (off by default). Extension UI dialogs
auto-cancel in v1; thread replay and rollback are stubs.

## Build and install

```bash
vp install --frozen-lockfile
vp run build:desktop
node scripts/install-local-windows-bundle.cjs \
  /home/kixey/t3code-wsl-fix \
  '/mnt/c/Users/kixey/AppData/Local/Programs/t3code/resources'
```

Close all T3 Code processes first — Windows file locks make the atomic swap
fail with `EACCES`. The script replaces only the compiled desktop and
server/web subtrees, rebuilds ASAR offsets and SHA-256 integrity metadata,
validates patch markers, performs atomic swaps, and keeps timestamped
official backups.

Current official backups:

```text
app.asar.pre-local-2026-08-26T08-54-35.897Z
server.asar.pre-local-2026-08-26T08-54-35.927Z
(app.asar.pre-local-2026-08-21T13-23-14.* retained from the .1151 install)
```

## Validation — 2026-08-26 (.1194 rebase)

- Rebase conflict resolved in `ProjectionPipeline.ts`: upstream's
  `shouldRefreshThreadShellSummary` and local `activityAffectsShellSummary`
  coexist (refresh gate vs incremental-append gate).
- Typecheck 0 errors: contracts, shared, client-runtime, server, web,
  desktop.
- Tests: server provider/orchestration suites 71/71; client-runtime reducer
  32/32; contracts settings/provider 48/48.
- Production desktop/server build passed (`vp run build:desktop`).
- Installer ran clean against the official `.1194` install; atomic swap with
  backups listed above.
- Installed-overlay marker checks (raw bytes):
  - `wsl-runtime` present in `app.asar` ✔
  - isolated-shell `noprofile` flag present in `app.asar` ✔
  - `desktop:preview-set-cookie` channel present in `app.asar` ✔
  - `activityAffectsShellSummary` present in `server.asar` ✔
  - `pi --mode rpc` / `Drivers/PiDriver` present in `server.asar` ✔
- Live relaunch check pending: confirm reported version
  `0.0.35-nightly.20260826.1194`, WSL ext4 entrypoint listening on
  `0.0.0.0:3773`, and a pi thread streaming end-to-end.

## Historical notes

The `.1026`–`.1151` era notes (WSL root cause analysis, resource-churn note,
slow-write fix measurements) were consolidated here on 2026-08-26. The slow-
write fix reduced measured server append mean from 813.9 ms to 9.29 ms and
client stable-ID update p95 from 5.3–8.1 ms to 0.20 ms; see the backup
branch `backup/pre-1194-rebase-20260826` for the full historical document.
