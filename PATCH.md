# T3 Code Windows/WSL startup patch

## Scope

- Patch base: `v0.0.33-nightly.20260807.1026`
- Installed Windows build: `0.0.33-nightly.20260807.1026`
- Upgraded from: `0.0.32-nightly.20260806.1014`
- Symptoms: T3 Code blocked during WSL preflight, showed repeated `WSL backend is still unavailable` dialogs, or remained on `Connecting to WSL…` after the backend was already healthy.

## Root cause

The packaged backend and its dependency tree were loaded directly from Windows at:

`/mnt/c/Users/kixey/AppData/Local/Programs/t3code/resources/app.asar.unpacked`

Cold WSL reads crossed the DrvFS/9P boundary repeatedly. The package is about 256 MB and 14,664 files, but startup read hundreds of megabytes before the hard-coded 10-second `node-pty` preflight expired. The backend also inherited `/mnt/c/Users/kixey` as its working directory, which made later provider discovery sensitive to the same slow boundary.

With WSL mirrored networking and Docker bridges present, `hostname -I` returned `172.19.0.1` first. T3 selected that unrelated Linux-only bridge as the renderer and readiness host. The backend listened successfully and Windows could reach it through `127.0.0.1`, but the desktop retried `http://172.19.0.1:3773` forever and left the splash visible.

## Source changes

1. `DesktopWslEnvironment` stages packaged `apps/server` and `node_modules` into WSL's native filesystem at `${XDG_CACHE_HOME:-$HOME/.cache}/t3code/wsl-runtime/current`.
2. Staging uses a version marker, `flock`, a ten-minute bounded copy, and an atomic `current`/`previous` swap so an interrupted refresh keeps the last usable runtime.
3. The `node-pty` preflight resolves and loads dependencies from the staged Linux path.
4. The WSL probe timeout is raised from 10 seconds to 60 seconds so a cold distro does not immediately fall back to the Windows backend.
5. The WSL backend launches the staged `apps/server/dist/bin.mjs` and adds `wsl.exe --cd ~` so provider processes start from the Linux home directory.
6. The Codex status probe uses provider `HOME`, then `USERPROFILE`, then `process.cwd()` as a final fallback.
7. WSL address discovery queries `wslinfo --networking-mode`, uses loopback for mirrored networking, and preserves the distro address for NAT mode.
8. Tests cover packaged staging, native launch paths, mirrored/NAT address selection, the WSL home working directory, and the Codex probe working directory.

## Installed-build workaround

Until a Windows artifact containing the source patch is installed, the unpacked `.1026` runtime is copied to:

`/home/kixey/.cache/t3code/wsl-runtime/current`

That native directory is bind-mounted over the WSL view of `app.asar.unpacked`. Windows still sees the original installation, while WSL reads the backend from ext4. Refresh this cache after every T3 update before relaunching the app.

The cached packaged entrypoint also performs `process.chdir(process.env.HOME)` before server startup. This gives the installed artifact the same provider working-directory behavior as the source patch's `wsl.exe --cd ~` change.

For an official artifact without the source fixes, run `scripts/patch-installed-wsl-timeout.cjs <resources/app.asar>`. It performs same-length replacements for the 10→60 second preflight timeout and mirrored-network loopback selection, updates the ASAR entry integrity hashes, verifies both changes, and keeps the original archive as `app.asar.pre-wsl-hotpatch`.

## Validation

- Desktop WSL tests: 52 passed.
- Focused Codex provider test: passed.
- Desktop and server typechecks: passed.
- Formatting, lint, and `git diff --check`: passed.
- Native runtime mount verified as `ext4`.
- On `.1026`, the backend listened in about 1 second. The live trace reached `backend ready` and created the main window in about 5.6 seconds at `http://127.0.0.1:3773/`.
- The launched backend's working directory is `/home/kixey`.
- The running server reports `0.0.33-nightly.20260807.1026`, and the Windows process is responsive.
- Codex `0.147.0` and Claude `2.1.224` both refreshed to `ready`.

The full `ProviderRegistry.test.ts` still has one pre-existing timing-sensitive test (`re-probes when settings change the codex binaryPath`) that also fails on the unmodified earlier release; it is unrelated to this patch.

## Update note

Official nightly `.1026` was published on 2026-08-07. Its upstream delta does not contain either WSL startup fix, so the patch still has to be reapplied after updating. The server bundle changed, but the dependency lockfile did not; cache refreshes can reuse the existing `node_modules` tree and replace only `apps/server`.

## 2026-08-07 resource-churn note

The observed CPU and disk spike was not Supermemory; that service remained stopped. The main disk reader was a stale whole-home Codex `rg` search using about 3.9 CPU cores, 850 MB RSS, and 60 MB/s reads. T3 also owned an active Vitest/browser test run. The exact stale search was terminated, and the T3-owned workers ended when the app closed for the update. After relaunch, Linux samples showed no process above 1 MB/s disk I/O. A later provider refresh used about 34% of one CPU core in the T3 backend without disk churn; the Windows T3 process was at 0.7 MB/s and 10% of one core.
