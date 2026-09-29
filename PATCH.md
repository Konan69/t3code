# T3 Code Cloudbox fork overlay

`local/boat` is the single maintained branch of the Konan69/t3code fork. It contains the Cloudbox build, the fork desktop update feed, and upstream T3 Code through the v0.0.44 nightly merge. Keep upstream features and this overlay together when resolving later merges.

## Overlay

- Native pi provider: `pi --mode rpc`, model discovery, MCP tools, and client controls.
- Provider and runtime fixes: pi stdin queue writing, process exit and stderr diagnostics, OpenCode fixes, and host process launching.
- WSL hardening: native ext4 staging, isolated shell startup, stable backend discovery, and content-addressed runtime handling.
- Cloudbox host lifecycle and wake: host status and controls, relay wake APIs, desktop wake IPC, and mobile queued-work recovery. Thread machines and their workspace bindings remain part of the build.
- Fork SSH releases: the SSH runner downloads its versioned Linux archive and `SHA256SUMS` from `https://github.com/Konan69/t3code/releases/download/v$VERSION/`. It has no official-host fallback.
- Fork desktop update feed: the desktop detects upstream nightlies, then dispatches `.github/workflows/fork-release.yml` for `local/boat` when the user requests an update. The fork workflow publishes the Windows x64 installer and updater manifest, plus the Linux x64 CLI archive and `SHA256SUMS`. The packaged upstream feed detects new nightlies; download switches to the Konan69 release after the fork build is ready.

## Migration compatibility

Upstream migration 054 (`ProjectionThreadsAutoSettleDisabledAt`) precedes the fork's registered migration ids 900–902. Keep these fork ids and names stable because existing fork databases may already have applied them:

```text
900 ProjectionMachineBindings
901 ProjectionMachineProjectWorkspaceRoot
902 RepairProjectionProjectsAutoPull
```

Run `scripts/check-migration-id-collisions.ts` against the upstream tag's registry and the merged registry before release.

## Updating the fork release

1. Merge the desired upstream nightly tag into `local/boat`, resolve conflicts preserving upstream and overlay behavior, and push `local/boat` to Konan69/t3code.
2. Dispatch `fork-release.yml` on `local/boat` with `upstream_tag` set to that upstream nightly tag and `branch=local/boat`.
3. Watch the workflow, then check its prerelease assets: Windows x64 installer, `nightly.yml` and blockmap, `SHA256SUMS`, and `t3-<version>-linux-x64.tar.gz`.

The workflow does not auto-resolve merge conflicts. If it opens a merge-conflict issue, resolve the reported files on `local/boat`, push the fix, and dispatch again. A source nightly sequence `N` maps to a fork release `<core>-nightly.<date>.<N>.1`, which sorts between upstream `N` and `N+1` for electron-updater.

The first fork Windows installation must be installed manually from a Konan69/t3code prerelease. Later fork installations can use the in-app updater.
