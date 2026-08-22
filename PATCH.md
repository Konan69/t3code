# T3 Code local Windows/WSL patch overlay

## Current build — 2026-08-21

- Official shell/tag: `v0.0.34-nightly.20260821.1151` (`be7d35aa`)
- Upstream `origin/main`: `be7d35aa` (identical to the shipped tag when fetched)
- Local branch: `local/main-20260821-nightly-1151-patched`
- Local overlay head before this documentation commit: `20d1459a`
- Pre-rebase backup branch:
  `backup/nightly-1093-patched-pre-1151-20260821`

The signed `.1151` installer was installed first. A production build from this
branch was then overlaid on its desktop and server archives. Automatic T3 Code
updates replace the overlay, so rebuild and rerun the installer script after
each official update.

## Patch set

| Area                    | Commits                            | Result                                                                                                              |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| WSL startup             | `6ecd5e4c`, `7cbeae77`             | Native-ext4 runtime staging, 60-second probe, isolated non-login shell, stable Codex cwd, mirrored-network loopback |
| Preview cookies         | `ce3c6f7c`, `2de6f4e2`             | Typed cookie IPC/tool/UI; cookie writes skip unrelated preview-session sync                                         |
| Server activity writes  | `1d8e2946`                         | Streaming/tool activity no longer reloads the entire thread history to rebuild its shell summary                    |
| Client activity updates | `1898c035`, `7bdd63bd`, `c211c471` | Indexed append/replacement path; stable-ID progress updates stop filtering and sorting the full activity history    |
| Provider settings       | `2a765559`                         | Acquires the settings PubSub subscription before forking its watcher, closing a dropped-update race                 |
| `.1151` packaging       | `20d1459a`                         | Atomically overlays the new dedicated `server.asar` as well as `app.asar`                                           |

### Complete reapply manifest

Apply every entry below, in order, after rebasing onto a new official release.
This is the authoritative code/test/tooling patch list; do not select only the
WSL commits.

```text
6ecd5e4c fix(desktop): stabilize WSL startup
ce3c6f7c feat(preview): add cookie setting
2de6f4e2 fix(preview): cookie writes skip session sync
7cbeae77 fix(desktop): isolate WSL backend shell
1d8e2946 perf: make streaming projection and activity appends incremental
1898c035 perf: index activity ids so streamed appends stop rescanning history
7bdd63bd fix: gate the activity append fast path on reducer-produced ordering
c211c471 perf(client): update stable activities incrementally
2a765559 fix(server): subscribe before provider settings hydration
fc8a06b2 test: reconcile local regressions with nightly 1151
c0dc19d4 feat(provider): add native pi driver over pi --mode rpc
```

20d1459a fix(desktop): overlay dedicated server archive

````

The slow-write fix is the four-commit block from `1d8e2946` through
`c211c471`; both its server and client halves are mandatory. `fc8a06b2` carries
the rebased regression coverage and must travel with the code.

Documentation-only history (`5058cc41`, `317e69e7`, `deb7d2f9`, `c4cf4ac2`,
and `2abc39ff`) records older installed states and is not part of the next
release's code cherry-pick. Rewrite this file after validating the new build.

### WSL startup

Upstream `.1151` now extracts the signed server sidecar into Windows storage.
The local patch retains that upstream mechanism, then stages the backend and
dependencies into native WSL ext4 storage at:

```text
${XDG_CACHE_HOME:-$HOME/.cache}/t3code/wsl-runtime/current
````

Staging is versioned, locked with `flock`, bounded, and atomically swapped. The
backend launches from ext4 with the Linux home as cwd. The probe timeout is 60
seconds, and WSL commands use `bash --noprofile --norc -s`; login profiles had
previously changed a successful staging script's exit status to `1`.

### Activity slow-write fix

The regression was full-history read amplification, not Claude/Codex
authentication. Each ordinary `thread.activity-appended` event rebuilt the
thread shell summary. On the largest measured thread that meant decoding about
19,555 rows / 67.2 MiB per streamed update.

The server patch limits summary refreshes to events that can change approval or
user-input counters. The client patches use a per-array ID index and preserve
sorted order without rescanning the whole activity history. Previous measured
server append mean fell from 813.9 ms to 9.29 ms; the 20,192-row client replay
p95 fell from 5.3–8.1 ms per stable-ID update to 0.20 ms.

Upstream `.1151` still lacks the local `activityAffectsShellSummary` and
indexed-reducer changes. See
[the upstream comparison](docs/internals/thread-activity-projection-upstream-status.md).

### Provider settings race

The `.1151` rebase exposed a real lazy-PubSub race: the settings watcher was
forked before its stream acquired a subscription, so an update published in
that scheduling window was permanently lost. `2a765559` acquires
`subscribeChanges` synchronously, then forks the consumer. Its regression test
waits on a `Deferred` at the second provider probe, making the previously flaky
failure deterministic.

### pi driver

`c0dc19d4` adds a first-class `pi` provider driver speaking `pi --mode rpc`
(JSONL over stdin/stdout). One child process per thread; prompt/steer/abort,
streaming text + reasoning deltas, tool lifecycle items, usage updates,
compaction items, and turn settle/abort are mapped to canonical runtime
events. Extension UI dialogs auto-cancel in v1; thread replay (`readThread`)
and `rollbackThread` are stubs. Enable it in Settings → Providers → pi
(off by default, like Grok/OpenCode). Typecheck clean across contracts,
shared, server, web, desktop; mobile has 55 pre-existing baseline errors
unrelated to this change. Provider registry tests updated (44/44).

## Build and install

```bash
vp install --frozen-lockfile
vp run build:desktop
node scripts/install-local-windows-bundle.cjs \
  /home/kixey/t3code-wsl-fix \
  '/mnt/c/Users/kixey/AppData/Local/Programs/t3code/resources'
```

The script replaces only the compiled desktop and server/web subtrees. It
rebuilds ASAR offsets and SHA-256 integrity metadata, validates patch markers,
performs atomic swaps, and keeps timestamped official backups. It supports both
the older unpacked-server layout and `.1151`'s dedicated `server.asar`.

Current official backups:

```text
app.asar.pre-local-2026-08-21T13-23-14.698Z
server.asar.pre-local-2026-08-21T13-23-14.700Z
```

For an untouched older artifact, the narrow same-length fallback remains:

```bash
node scripts/patch-installed-wsl-timeout.cjs <resources/app.asar>
```

That fallback changes only the timeout and mirrored-network choice; it does not
install the full patch set.

## Validation

- Official installer size: `146191400`; release SHA-512 matched; Authenticode
  status `Valid`, signer `T3 Tools Inc`.
- Targeted tests passed: desktop 134/134, server 81/81, client reducer 33/33,
  preview target 5/5.
- Typechecks passed for contracts, client runtime, server, desktop, and web.
- Combined production desktop/server build passed.
- Dry-run overlay on copies matched source hashes for desktop main, server
  entrypoint, and the hashed client asset.
- Live runtime version: `0.0.34-nightly.20260821.1151`.
- Live backend: WSL ext4 entrypoint, listening on `0.0.0.0:3773`.
- Live `bin.mjs` SHA-256 matches source and `server.asar`:
  `2920fefb4c298b45f027936a0fc80aa69c5e309c44ebf5fee558d0250a7c748b`.
- Live client asset SHA-256 matches source:
  `7d1663bbafd9f852696e374bd58a4fa7fc32fe7d2bea836c2c90d63ab2730005`.
- Post-start sample: no WSL I/O wait; backend wrote about 40 KiB in four
  seconds and averaged 6% of one CPU core during provider/thread hydration.

The original cookie worktree at `/home/kixey/t3code` remains untouched.
