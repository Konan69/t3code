# T3 Code Windows/WSL, preview-cookie, and activity-performance patches

## Current build

- Installed official shell/tag: `v0.0.34-nightly.20260814.1093`
  (`184d8ef3`)
- Source base: upstream `main` at `1add47b3`, three commits newer than `.1093`
- Local branch: `local/main-20260814-pr6608-patched`
- Previous patched build backup: `backup/nightly-1076-patched-20260814`
- WSL commits: `3694fce3 fix(desktop): stabilize WSL startup` and
  `d58e028d fix(desktop): isolate WSL backend shell`
- Cookie commits: `3381df48 feat(preview): add cookie setting` and
  `c5b1a89d fix(preview): cookie writes skip session sync`
- Activity-performance commits from upstream PR #6608: `1a76870a`,
  `b917d9f4`, and `ef2eb07f`
- Stable-ID client fix: `9f4671f7 perf(client): update stable activities
incrementally`

The signed `.1093` installer was installed first. A production build from this
branch was then overlaid on its desktop/server bundles. The official tag and
current upstream `main` contain none of the local WSL/cookie patches and do not
yet contain PR #6608.

## WSL failures and fixes

The packaged backend originally loaded about 256 MB across thousands of files
from `app.asar.unpacked` on the Windows `C:` drive. Cold DrvFS/9P reads could
outlive the hard-coded ten-second `node-pty` preflight and leave the app on
`Connecting to WSL…` or show repeated unavailable-backend dialogs.

The source patch:

1. Stages packaged `apps/server` and `node_modules` in native ext4 storage at
   `${XDG_CACHE_HOME:-$HOME/.cache}/t3code/wsl-runtime/current`.
2. Uses a version marker, `flock`, bounded staging, and an atomic swap.
3. Raises the WSL probe window from 10 to 60 seconds.
4. Launches the backend from the staged entrypoint with the Linux home as cwd.
5. Uses loopback in mirrored WSL networking instead of selecting a Docker
   bridge returned first by `hostname -I`.
6. Gives Codex provider checks a stable cwd from `HOME`, then `USERPROFILE`,
   then `process.cwd()`.

### Login-profile exit-code regression

On this machine, a strict Bash script succeeds but `bash -l` changes its exit
status during login/logout profile handling:

```text
strict-ok
strict-login-exit=1
strict-plain-exit=0
```

That produced the misleading `.1068` dialog:

```text
Failed to stage the T3 backend in WSL native storage (exit 1):
runtimeRoot:/home/kixey/.cache/t3code/wsl-runtime/current
```

`DesktopWslEnvironment` now invokes
`bash --noprofile --norc -s`. The shared Node resolver already discovers the
supported version managers, so user profiles are unnecessary. The exact stage
script now prints the same runtime root and exits `0`.

## Preview-cookie patch

The preview stack now exposes a typed `desktop:preview-set-cookie` IPC path,
desktop session handling, MCP/tooling support, and renderer controls for
setting cookies. Cookie-only mutations bypass the preview-session sync path so
writing one cookie does not trigger the unrelated session synchronization
cycle.

The original cookie worktree at `/home/kixey/t3code` was not modified; its
uncommitted provider-probe edits remain there untouched.

## Installing a locally built bundle

The signed official installer remains the Windows shell. Build the combined
source and overlay only the compiled app files:

```bash
vp install --frozen-lockfile
vp run build:desktop
node scripts/install-local-windows-bundle.cjs \
  /home/kixey/t3code-wsl-fix \
  '/mnt/c/Users/kixey/AppData/Local/Programs/t3code/resources'
```

The overlay script updates packed `apps/desktop/dist-electron` entries and
unpacked `apps/server/dist` while preserving the official dependency tree. It
updates ASAR offsets, sizes, and SHA-256 entry integrity, validates the cookie
and WSL markers, and keeps timestamped archive/server backups. It avoids
recopying all of `node_modules` across DrvFS.

For an unmodified official artifact, the older same-length workaround remains
available as `scripts/patch-installed-wsl-timeout.cjs <resources/app.asar>`.
It patches only the 10→60 second timeout and mirrored-network loopback choice.

The `.1093` WSL runtime is staged on ext4 and its `bin.mjs` SHA-256 matches the
source build. Earlier `.1026` and `.1068` caches remain available as rollback
copies.

## Thread activity slow-write fix

The write regression was server-side read amplification, not Claude/Codex
authentication. Every `thread.activity-appended` event rebuilt the thread shell
summary, loading and decoding the thread's full activity history. The largest
active thread had about 19,555 activity rows / 67.2 MiB, and the local database
was about 1.23 GiB.

[Upstream status](docs/internals/thread-activity-projection-upstream-status.md)
confirms that `.1076`, `.1093`, and current `main` have byte-identical hot-path
code. Open PR #6608 makes ordinary streaming/tool activity projection
incremental and gives the client an indexed append path. A second local client
fix keeps same-ID progress updates on that indexed path: it replaces the
existing row in a copied sorted array and ignores byte-equivalent redeliveries.
Previously, each same-ID update filtered, sorted, and rebuilt an index for all
activities. PR #6613 is a separate partial optimization for the rare summary
refreshes and is not required for the measured agent-write path.

Live before/after measurements:

| Build              |         Samples |     Mean |  Median |      p95 |      Max |
| ------------------ | --------------: | -------: | ------: | -------: | -------: |
| Unpatched          | traced baseline | 813.9 ms |  687 ms |   1.96 s |   5.92 s |
| `.1093` + PR #6608 |              22 |  9.29 ms | 8.71 ms | 11.20 ms | 16.74 ms |

That is about an 88x reduction in mean append latency. Lifecycle/session events
can still perform a shell-summary refresh; they are no longer on each streamed
agent activity append.

The remaining client slowdown reproduced on the active 20,192-activity Codex
thread. Stable-ID `task.progress` reducer updates took 5.3–8.1 ms at this size
and crossed 2 ms around 5,000 activities. The indexed replacement fix reduced
the 20,192-row replay p95 to 0.20 ms and suppresses identical redeliveries,
avoiding unnecessary React updates.

## Validation — 2026-08-14

- Official `.1093` installer: exact release size `148095040`; release
  SHA-512 matched; Authenticode status `Valid`, signer `T3 Tools Inc`.
- PR #6608 plus stable-ID regression suites: client runtime 605/605 passed;
  the focused reducer suite passed 33/33.
- Carried WSL/cookie suites: desktop 87/87 across three runnable files and
  server 50/51 passed. The one server failure is an unrelated settings-watcher
  timing test already present on upstream `main`; the isolated local Codex cwd
  regression passes.
- Typecheck passed for contracts, client runtime, web, desktop, and server.
- Combined production desktop/server build passed.
- Installed bundle markers include cookie IPC, native WSL cache, isolated
  non-login shell, mirrored networking, and `activityAffectsShellSummary`.
- Installed WSL `bin.mjs` matches the build SHA-256
  `62be5f8a01836740695786309ea19ff46143abd8eafe71a2e98ca74288a6c43d`.
- The production client asset SHA-256 matches across source, the Windows
  overlay, and the ext4 WSL runtime.
- First `.1093` WSL staging took 71.63 s; the warm restart stage lookup took
  274.9 ms and total WSL preflight took 946.6 ms.
- Backend: healthy on `0.0.0.0:3773`, cwd `/home/kixey`, entrypoint under the
  ext4 runtime cache, Linux x64 environment endpoint healthy.
- Five-second post-install sample: backend averaged 1.2% of one CPU core at
  about 397 MiB RSS; the four Windows processes totaled 2.8% and 571 MiB.
- Desktop trace: `backend ready` and `main window created`; Windows main window
  is responsive.

One desktop-configuration test file still cannot import Electron because the
user environment intentionally sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`. Its
other three focused files pass; this is a test-runtime setup limitation.

## Resource-churn note

The large CPU spike was not this build or Supermemory. A separate T3 Codex
desktop session, `019ff1f2-5307-7343-a75c-fe6c1908ac98`, launched whole-home
`rg` scans from `/home/kixey/agency/garden` while handling “find the old PRs and
restore them.” One scan reached roughly 590% CPU. Those scans exited, and a
follow-up process check found no matching whole-home `rg` and no stray T3
server before installation.
