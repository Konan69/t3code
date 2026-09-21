# T3 Code local boat overlay

## Current base

- Working branch: `local/boat`
- Starting commit: `099287af0f0d1d28805942ffc977e669d98a98b0`
- Upstream release in that merge: `v0.0.43-nightly.20260920.2031`

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
