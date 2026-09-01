# T3 Code local Windows/WSL patch overlay

## Current build — 2026-09-01

- Official Windows shell/tag: `v0.0.38-nightly.20260901.1244`
- Upstream source base: `origin/main` at `0bfb6df34` (one commit ahead of the
  `.1244` tag)
- Combined local branch:
  `local/main-20260901-nightly-1244-cloudbox-patched`
- Pre-rebase backups: `backup/pre-1244-full-overlay-20260901` and
  `backup/pre-1244-cloudbox-20260901`
- Previous source branch: `local/main-20260828-nightly-1210-patched`
- Windows executable now reports:
  `0.0.38-nightly.20260901.1244`

Automatic official updates replace the overlay. After each official update:
install the signed official shell first, rebase this manifest onto the new
source, rebuild, and rerun the overlay installer.

## Important shell/update lesson from 2026-08-28

The `.1194` source rebase was initially overlaid onto an older `.1151` Windows
shell. The compiled server/web code was current, but the executable still
reported:

```text
FileVersion=0.0.34-nightly.20260821.1151
```

That is why T3 Code correctly kept offering `.1194`. The updater cache also
contained the old `.1151` installer (146,191,400 bytes), so it could not finish
the upgrade by itself.

The fix was:

1. Fetch the actual latest release (`.1210`, not `.1194`).
2. Download the official x64 installer from GitHub Releases.
3. Verify Authenticode before execution.
4. Install the official shell silently.
5. Verify the executable `FileVersion`.
6. Reapply the local overlay.

`.1210` installer evidence:

```text
Size:   142525176
Signer: CN=T3 Tools Inc, O=T3 Tools Inc, L=San Fransisco, S=California, C=US
Status: Valid
SHA256: DF6C0005CDCCF3182B147F7B29FC63885CB4F47ADF4B853A84C2F00F0A0B1383
```

`T3CODE_DISABLE_AUTO_UPDATE=1` was temporarily set while diagnosing the stale
prompt. It was removed after the official `.1210` shell was installed.
Official auto-updates are enabled again.

**Do not declare an update complete from source/version text alone. Always
verify the Windows executable's `FileVersion`.**

## Rebase audit — `.1194` to `.1210`

`a3a8cbd6..9257bd86` contains 26 upstream commits. None absorbed the functional
local patches:

| Area                       | Upstream signal                                         | Verdict |
| -------------------------- | ------------------------------------------------------- | ------- |
| WSL ext4 staging           | no `wsl-runtime` marker                                 | keep    |
| Preview cookie set IPC     | no `desktop:preview-set-cookie` marker                  | keep    |
| Activity append/index perf | no `activityAffectsShellSummary` marker                 | keep    |
| Settings hydration race    | no equivalent fix                                       | keep    |
| Provider settings UI       | upstream split list/editor; local pi UI applied cleanly | keep    |
| Superseded docs history    | represented by this file                                | drop    |

The `.1210` rebase applied without conflicts.

## Patch set

| Area                    | Commits (current hashes)           | Result                                                                                                      |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| WSL startup             | `c61483da`, `0c11a1eb`             | Native-ext4 staging, 60-second probe, isolated non-login shell, stable Codex cwd, mirrored-network loopback |
| Preview cookies         | `af53e72e`, `f026864a`             | Typed cookie set IPC/tool/UI; writes skip unrelated preview-session sync                                    |
| Server activity writes  | `d6beaada`                         | Incremental append path avoids full-history shell-summary reloads                                           |
| Client activity updates | `ff6a5272`, `28d79d85`, `26e18098` | Indexed append/replacement and stable-ID updates                                                            |
| Provider settings race  | `c4f00dc3`                         | Subscribe before settings watcher hydration                                                                 |
| Regression coverage     | `50ca779c`                         | Local regression tests                                                                                      |
| Packaging tooling       | `1075bb49`                         | Local Windows ASAR overlay installer with dedicated `server.asar` support                                   |
| pi provider             | `f5f0c955`                         | Native `pi --mode rpc` server driver                                                                        |
| pi web surfaces         | `da4659dd`                         | Provider settings row, picker option, model placeholder, and `PiAgentIcon`                                  |
| pi model catalog        | `2f07fc33`                         | Live RPC discovery, provenance, exact provider exclusions, order-independent search, and provider filters   |

### Complete reapply manifest

Apply in this order after each future upstream rebase:

```text
c61483da fix(desktop): stabilize WSL startup
af53e72e feat(preview): add cookie setting
f026864a fix(preview): cookie writes skip session sync
0c11a1eb fix(desktop): isolate WSL backend shell
d6beaada perf: make streaming projection and activity appends incremental
ff6a5272 perf: index activity ids so streamed appends stop rescanning history
28d79d85 fix: gate the activity append fast path on reducer-produced ordering
26e18098 perf(client): update stable activities incrementally
c4f00dc3 fix(server): subscribe before provider settings hydration
50ca779c test: reconcile local regressions with nightly 1151
1075bb49 chore(desktop): restore local Windows bundle installer
f5f0c955 feat(provider): add native pi driver over pi --mode rpc
da4659dd feat(web): surface pi in provider settings, picker, and icons
2f07fc33 feat(provider): discover pi models and filter by upstream provider
```

`20d1459a` (dedicated server archive support) is consolidated into
`1075bb49`. The installer script is local tooling and does not exist upstream.

## pi provider driver

`f5f0c955` adds a first-class `pi` provider alongside Codex, Claude, Cursor,
Grok, and OpenCode. One `pi --mode rpc` child runs per thread. The adapter uses
strict LF JSONL framing, correlated command IDs, and maps pi events into T3's
canonical content, reasoning, tool, usage, compaction, retry, turn-complete,
and turn-abort events.

`da4659dd` makes pi visible in:

- Settings → Providers
- provider/model picker
- provider icon maps (`PiAgentIcon`)
- custom-model placeholder UI

`2f07fc33` replaces the original three-model stub with live
`get_available_models` + `get_state` discovery. It preserves extension-backed
providers (including the user's Claude subscription via `claude-bridge`), marks
the active default model, and stamps `subProvider` provenance. The configured
exact exclusions are:

```text
google, openai, anthropic, opencode-go
```

Exact matching preserves `openai-codex`, `claude-bridge`, `opencode`, and
`openrouter`. The current live catalog is 446 visible models across those four
providers. Both the model picker and Settings model list support provider
dropdowns plus AND-across-token, order-independent searches over model name,
provider, and full slug (`open 5.4`, `5.4 open`, etc.). OpenCode uses the same
provenance/search/filter UI.

V1 limitations: extension UI dialogs auto-cancel; historical `readThread` replay
and `rollbackThread` are not implemented yet.

## Cloudbox and thread-machine overlay

The `.1244` branch includes the full prior Windows/WSL/pi overlay plus the
complete `local/cloudbox` line:

- host-local and Incus-backed machine service boundaries
- per-thread golden machines, ZFS lifecycle, workspace and identity mounts
- provider launch routing inside thread machines, including pi stdin handling
- relay wake policies, host lifecycle APIs, explicit wake-on-interaction
- desktop/web Connections controls and thread-machine workspace labels
- mobile queued-work wake recovery
- Cloudbox EAS channels and personal iOS sideload workflow

The rebase preserved upstream `.1244` WSL runtime-archive hardening and OpenCode
password/version support while retaining machine process launch and provider
exit diagnostics. Current reapply order is the first-parent sequence from:

```bash
git log --first-parent --reverse --oneline origin/main..HEAD
```

## Build and install

```bash
vp install --frozen-lockfile
vp run build:desktop
node scripts/install-local-windows-bundle.cjs \
  /home/kixey/t3code-wsl-fix \
  '/mnt/c/Users/kixey/AppData/Local/Programs/t3code/resources'
```

Close every T3 Code process first. Windows file locks otherwise make the atomic
ASAR swap fail with `EACCES`. The script rewrites only compiled desktop and
server/web subtrees, rebuilds ASAR offsets/integrity metadata, validates patch
markers, performs atomic swaps, and keeps timestamped official backups.

Current `.1210` official backups:

```text
app.asar.pre-local-2026-08-28T14-27-53.965Z
server.asar.pre-local-2026-08-28T14-27-53.968Z
```

Older `.1151`/intermediate backups remain in the resources directory.

## Validation — `.1244`

- Official installer Authenticode: `Valid`, signed by `T3 Tools Inc`.
- Official executable after install:
  `0.0.38-nightly.20260901.1244`.
- All 15 workspace typechecks: passed.
- Targeted rebase/conflict suites: passed, including 62/62 server projection
  and Incus tests, 809/809 client-runtime tests, 51/51 WSL runtime tests, and
  71/71 lint-plugin tests.
- `vp run build:desktop`: passed.
- Overlay installer: passed against the official `.1244` shell with WSL,
  preview-cookie, pi, Claude Bridge, and machine-service markers.
- Relaunched backend: listening on WSL port `3773`.

## Historical validation — `.1210`

- Official installer Authenticode: `Valid`, signed by `T3 Tools Inc`.
- Official executable after install:
  `0.0.36-nightly.20260828.1210`.
- Typecheck: 0 errors in contracts, client-runtime, server, web, desktop.
- Tests: server provider/orchestration 72/72; client reducer 32/32; contracts
  settings/provider 69/69; pi/OpenCode/provider registry 56/56; model search 9/9.
- `vp run build:desktop`: passed.
- Overlay installer: passed against the official `.1210` shell.
- Installed raw-marker checks:
  - `wsl-runtime` in `app.asar` ✔
  - `noprofile` isolated-shell flag in `app.asar` ✔
  - `desktop:preview-set-cookie` in `app.asar` ✔
  - `activityAffectsShellSummary` in `server.asar` ✔
  - `pi --mode rpc` in `server.asar` ✔
  - `PiAgentIcon` / pi settings UI in `server.asar` ✔

Live relaunch still needs one UI confirmation: Settings → Providers contains the
pi row, then start one pi thread and verify end-to-end streaming.

## Resource-churn incident — 2026-08-28

The sustained memory/CPU churn was not T3's ASAR staging. A stale user service
was running:

```text
~/.supermemory/bin/supermemory-server
CPU: ~104% for 7+ hours
RSS: ~2.3 GiB
```

Actions taken:

- force-killed `supermemory-server` and its Rivet sidecar;
- disabled `supermemory.service` and `supermemory-retry-batches.service`;
- added systemd user drop-ins with `ExecStart=/bin/false`;
- reloaded the user systemd manager;
- verified `supermemory.service` reports `masked` and no process is running.

Observed memory after cleanup: about 2.5 GiB used / 9.4 GiB available (12 GiB
WSL allocation). Do not re-enable these units unless Supermemory is explicitly
wanted again.

## Historical notes

The `.1026`–`.1194` history is preserved on backup branches:

```text
backup/pre-1194-rebase-20260826
backup/pre-1210-rebase-20260828
```

The original slow-write measurements reduced server append mean from 813.9 ms
to 9.29 ms and client stable-ID update p95 from 5.3–8.1 ms to 0.20 ms.
