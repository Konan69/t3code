# T3 Code local boat overlay

## Current base

- Working branch: `local/boat`
- Starting commit: `099287af0f0d1d28805942ffc977e669d98a98b0`
- Upstream release in that merge: `v0.0.43-nightly.20260923.2150`

## Remote-host decision

The previous GCP cloud-host design is retired. This fork now uses one boat.dev sandbox as a normal T3 SSH environment.

The target is T3's stock remote model:

- one remote machine;
- one T3 server on that machine;
- threads represented by worktrees on that server;
- the desktop SSH environment installs and runs the release archive, then tunnels to the server.

There is no per-thread machine provisioning and no cloud wake service. Stock T3 connection, relay, SSH, worktree, and provider behavior remains intact.

## Active overlay

The active product overlay is now:

1. **Native pi driver** — `pi --mode rpc`, live model discovery, T3 MCP tools, and the pi web/provider surfaces.
2. **Provider fixes** — the pi stdin queue writer, provider exit/stderr diagnostics, OpenCode fixes, and the plain host `ProcessLauncher` route shared by provider children.
3. **WSL hardening** — native-ext4 runtime staging, isolated shell startup, stable backend discovery, and content-addressed runtime handling.
4. **Fork SSH releases** — production SSH environments fetch the matching server archive from:

   ```text
   https://github.com/Konan69/t3code/releases/download/v$VERSION/
   ```

   The runner downloads `SHA256SUMS` and the platform archive from that tag. There is no fallback to the official release host.

## Removed overlay behavior

- Per-thread host-local and container-backed machines, provisioning, process routing, workspace bindings, identity mounts, settings, and UI labels.
- GCP wake configuration, wake intent and policy state, host lifecycle relay APIs, desktop/web controls, and mobile queued-work wake recovery.
- Fork-specific mobile build channels and the personal sideload workflow that belonged to the retired cloud-host setup.

## Migration compatibility

Keep these migrations registered at their existing ids and names:

```text
900 ProjectionMachineBindings
901 ProjectionMachineProjectWorkspaceRoot
902 RepairProjectionProjectsAutoPull
```

Existing fork databases may already record them as applied. Do not remove, rename, or renumber them. Their tables and columns may remain unused.

## Release archive contract

For version `0.0.43-nightly.20260920.2031` on Linux x64, the SSH runner requests:

```text
v0.0.43-nightly.20260920.2031/SHA256SUMS
v0.0.43-nightly.20260920.2031/t3-0.0.43-nightly.20260920.2031-linux-x64.tar.gz
```

Build a replacement archive from `local/boat`; the earlier archive was built from the starting commit and still contains the retired implementation.

Do not publish or install local artifacts as part of source maintenance. In particular, do not modify the currently installed Windows application while preparing this branch.

## Fork desktop update feed

The fork's `.github/workflows/fork-release.yml` has no schedule. The desktop app dispatches it after the user clicks Update for a detected upstream nightly; maintainers can also dispatch it manually with a required upstream tag. It merges that `pingdotgg/t3code` nightly tag into `local/fork-feed`, rejects upstream/fork migration-id collisions, and reuses the upstream desktop release workflow to publish only:

- the unsigned Windows x64 NSIS installer, blockmap, and `nightly.yml` updater manifest;
- the Linux x64 CLI archive embedded as the Windows WSL runtime;
- `SHA256SUMS` for the CLI archive.

The packaged `app-update.yml` follows `pingdotgg/t3code`, so checks detect upstream nightlies without building or downloading. On Update, the app uses `gh auth token --user Konan69` inside WSL, dispatches the fork workflow when needed, waits for its prerelease, and temporarily switches electron-updater to `Konan69/t3code` for download. A source version ending in nightly sequence `N` maps to `<core>-nightly.<date>.<N>.1`; it sorts above source nightly `N` and below upstream nightly `N+1` under electron-updater's semver comparison.

### One-time bootstrap

A stock installation does not contain the click-triggered fork build logic. Download and install the first fork Windows `.exe` manually from the [Konan69/t3code prereleases](https://github.com/Konan69/t3code/releases). After that one install, the fork app detects upstream nightlies and builds the matching fork release when Update is clicked.

### Merge-conflict issue

The workflow never resolves upstream merge conflicts automatically. When it opens or refreshes `fork-release: merge conflict on <tag>`:

1. Check out the overlay branch named in the workflow run.
2. Merge the reported upstream tag locally.
3. Resolve every listed file while preserving both upstream behavior and this overlay.
4. Commit and push the resolution, then rerun `fork-release.yml` for that branch.

Do not close the issue as a substitute for resolving the merge. The next run must complete the merge and migration guard before it can publish.
