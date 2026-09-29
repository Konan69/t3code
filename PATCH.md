# T3 Code Cloudbox overlay

`local/boat` is the single maintained branch of this fork. It combines the installed Cloudbox build with upstream T3 Code through the v0.0.44 nightly merge. Resolve later upstream merges with both sets of behavior intact.

## Overlay

- Native pi provider: `pi --mode rpc`, model discovery, MCP tools, and client controls.
- Provider and runtime fixes: pi stdin queue writing, process exit and stderr diagnostics, OpenCode fixes, and host process launching.
- WSL hardening: native ext4 staging, isolated shell startup, stable backend discovery, and content-addressed runtime handling.
- Cloudbox host lifecycle and wake: host status and controls, relay wake APIs, desktop wake IPC, and mobile queued-work recovery. Thread machines and workspace bindings remain part of the build.
- Fork SSH releases: the SSH runner downloads its versioned Linux archive and `SHA256SUMS` from `https://github.com/Konan69/t3code/releases/download/v$VERSION/`. There is no fallback to the official release host.

## Migration compatibility

Upstream migration 054 (`ProjectionThreadsAutoSettleDisabledAt`) precedes the fork's registered migration ids 900–902. Keep these fork ids and names stable because existing fork databases may already have applied them:

```text
900 ProjectionMachineBindings
901 ProjectionMachineProjectWorkspaceRoot
902 RepairProjectionProjectsAutoPull
```

## Updating the installed build

Merge upstream into `local/boat`, resolve integration errors, and build the Windows desktop asar resources plus the Linux x64 `t3` CLI archive locally. Stage the files in `~/t3code-staging/boat/`. Launch `~/t3code-staging/apply-boat.sh` detached with `systemd-run --user`; it logs to `~/t3code-staging/apply-boat.log` and waits until every T3 Code process has exited. It then backs up the installed resources as `*.pre-overlay-<UTC>`, swaps the staged overlay, and disables the stock updater for this installation so a pingdotgg nightly cannot replace it. It does not close or restart the app. `apply-boat.sh --rollback` waits the same way and restores the newest backup. Repeat the merge, build, and apply process for future updates.
