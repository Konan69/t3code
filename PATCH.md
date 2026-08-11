# T3 Code Windows/WSL and preview-cookie patches

## Current build

- Official base/tag: `v0.0.34-nightly.20260811.1068` (`ac4780f4`)
- Installed Windows build: `0.0.34-nightly.20260811.1068`
- Upgraded from: `0.0.33-nightly.20260807.1026`
- Local branch: `local/nightly-1068-patched`
- WSL patch commit: `2ba6c45e fix(desktop): stabilize WSL startup`
- Cookie commits: `2f76996f feat(preview): add cookie setting` and
  `dabdf288 fix(preview): cookie writes skip session sync`

The official `.1068` tag contains neither local cookie commit nor the WSL
startup patch. `git cherry` against the tag reports both cookie commits as
local-only.

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

The `.1068` WSL cache was pre-seeded from the source worktree on ext4 and
validated by resolving `effect` and loading the Linux `node-pty` binary. The
previous `.1026` cache is preserved at
`~/.cache/t3code/wsl-runtime/current.pre-local-1026-20260811` until the new
installation has had enough soak time.

## Validation — 2026-08-11

- Installer: exact size `154065496`, SHA-256
  `2a8733f95fd15c9a5daa3fb777e821e7c3b5b00ed5511b2bb31e2ab118b873a6`,
  Authenticode status `Valid`, signer `T3 Tools Inc`.
- Focused cookie/WSL suite: 5 files passed, 49 tests passed.
- WSL shell regression suite after the profile fix: 31 tests passed.
- Combined production source build: passed.
- Installed ASAR markers: cookie IPC, native WSL cache, mirrored networking,
  `--noprofile`, and `--norc` all present.
- WSL stage lookup: about 240 ms on the successful launch.
- Backend: listening on `0.0.0.0:3773`, cwd `/home/kixey`, entrypoint under the
  ext4 runtime cache, Linux x64 environment endpoint healthy.
- Desktop trace: `backend ready` and `main window created`; Windows main window
  is responsive.
- Windows file version: `0.0.34-nightly.20260811.1068`. The server package
  reports `0.0.33`, matching `apps/server/package.json` in this release.

One desktop-configuration test file could not import Electron because the user
environment intentionally sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`; the five
other focused files completed and passed. This is a test-runtime setup issue,
not an application failure.

## Resource-churn note

The large CPU spike was not this build or Supermemory. A separate T3 Codex
desktop session, `019ff1f2-5307-7343-a75c-fe6c1908ac98`, launched whole-home
`rg` scans from `/home/kixey/agency/garden` while handling “find the old PRs and
restore them.” One scan reached roughly 590% CPU. Those scans exited, and a
follow-up process check found no matching whole-home `rg` and no stray T3
server before installation.
