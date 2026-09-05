# Architecture

T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's. The desktop app bundles a server,
but its renderer follows the same boundary.

## Ownership boundaries

Provider processes, terminals, Git, and project files belong to the server. Shared connection and
domain state belongs in `packages/client-runtime`; clients supply platform services and UI.
Keeping that logic shared prevents reconnect and multi-environment behavior from diverging between
web and mobile. See [connection runtime](./connection-runtime.md) and
[remote environments](./remote.md).

The [RPC contract](../../packages/contracts/src/rpc.ts) is the boundary between independently
versioned clients and servers. Subscriptions send the state a client needs, so a client viewing one
thread does not pay for every thread's history. Authentication of a socket does not authorize every
method on it. See [environment auth](./environment-auth.md).

Provider-specific behavior belongs behind an adapter. Orchestration works with normalized commands
and events, so adding a provider should not require branches throughout the domain or clients.
See [provider constraints](./providers.md).

## Durable intent and side effects

The event log is the source of truth for orchestration state. The
[engine](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts) serializes commands;
the [decider](../../apps/server/src/orchestration/decider.ts) produces events without performing
provider or filesystem work. Events, persisted projections, and the accepted command receipt commit
in one database transaction. The in-memory state changes and subscribers receive events after that
commit. This keeps command retries idempotent and prevents a persisted projection from getting
ahead of the event log.

Reactors perform side effects after intent has been recorded, then feed results back through
commands. A command acknowledgement therefore means the intent committed, not that the provider,
checkpoint, or other follow-up work finished. Keep external I/O out of the decider and the database
transaction.

Persisted events must remain decodable on replay. Changing a schema affects old environments at
startup as well as live RPC traffic. Compatibility work must account for stored history, not just
what the newest client sends.

## Turn completion and checkpoints

A turn ending and its follow-up work settling are separate milestones. The
[projector](../../apps/server/src/orchestration/projector.ts) settles the turn from its session
status. A late checkpoint or diff must not extend the recorded turn duration or keep the client
showing provider work as active.

[Checkpoints](../../apps/server/src/checkpointing/CheckpointStore.ts) use hidden Git refs to
capture workspace state without adding commits to the user's branch. A revert must coordinate
workspace state with the provider conversation. A provider that cannot roll back its conversation
must reject that operation before changing the filesystem.

## Waiting for asynchronous work

Tests use [drainable workers](../../packages/shared/src/DrainableWorker.ts) to wait until both the
queue and its current item have finished. An empty queue alone does not prove the worker is idle.

Runtime receipts mark specific test milestones. Their
[production layer](../../apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts) is a no-op;
production behavior must use persisted state and events. These test signals are separate from the
durable command receipts that make dispatch idempotent.

See the [glossary](./glossary.md) for shared terms and the
[development runbook](../operations/development.md) for setup and checks.

## Thread machines

Native Linux servers can run a project's threads in Incus machines.

Machine-capable environments carry the requested machine mode in the atomic `project.create`
command. Web and mobile project creation enable it by default when the server advertises the
capability, preventing the first thread from racing or silently starting on the host.

| Provider | Thread-machine transport                               |
| -------- | ------------------------------------------------------ |
| Codex    | Direct process launch through `MachineProcessLauncher` |
| Claude   | SDK spawn hook delegates to `MachineProcessLauncher`   |
| Cursor   | Direct process launch through `MachineProcessLauncher` |
| Grok     | Direct process launch through `MachineProcessLauncher` |
| OpenCode | Direct process launch through `MachineProcessLauncher` |

Claude supplies the Agent SDK's `spawnClaudeCodeProcess` hook and adapts the resulting Effect process
handle back to the SDK's Node stream and lifecycle interface. The hook passes the SDK's command,
arguments, host workspace cwd, and full environment through the same launcher as the other providers;
machine-bound threads therefore resolve the command by basename and run the guest-installed `claude`.
No executable shim or wrapper file is created.

Machine mode requires `T3_MACHINE_IDENTITY_MANIFEST` to contain the absolute path of a JSON manifest
with this exact schema (no additional properties):

```json
{
  "version": 1,
  "mounts": [
    {
      "hostPath": "/absolute/host/directory",
      "guestPath": "/absolute/guest/directory",
      "readOnly": false
    }
  ]
}
```

Every `hostPath` must be an existing directory. A missing environment variable, unreadable or invalid
manifest, relative path, or non-directory host path fails machine creation before any identity device
is mounted. Incus disk devices use `shift=true`; read-only entries also use `readonly=true`. The idmap
makes host-user-owned directories appear owned by guest uid/gid 1000 without changing ownership on
the host.

Identity devices are reconciled at creation and before each machine process execution. Desired
mounts are added or updated by index and guest-path slug; stale `identity-*` devices are removed.

Every provider-facing working directory for a machine-bound thread uses the guest workspace path,
including session start and restart, per-turn generation, and provider tool or command execution.
The server keeps host workspace paths in projections and maps the workspace root and its
subdirectories only at the provider boundary.

The project checkout is mounted read-only at the same absolute host and guest path. A nested,
read-write mount exposes only the checkout's `.git` directory, so a Git worktree's `.git` file can
still resolve worktree metadata, shared objects, and refs without letting a confused agent modify the
user's checkout. The `project` and `project-git` disk devices use `shift=true` and are reconciled
before each machine process execution.

Dependency seeding for machine workspaces bind-mounts the project checkout's root and workspace
`node_modules` directories into the same relative paths in the thread worktree. This avoids a slow,
network-bound install for every fresh machine worktree and shares the checkout's already-installed
dependencies across threads. The mounts are read-write to preserve package-manager behavior, so
concurrent dependency installs from the checkout or machine workspaces are discouraged.

Each thread machine receives its own host Git worktree. An unset thread branch creates
`t3/<machineName>` from the project checkout's current branch. An existing branch is checked out
directly only when no project worktree already uses it; otherwise the machine gets a new
`t3/<machineName>` branch based on the requested branch, and the thread metadata follows that new
branch. Locked and prunable worktree registrations still reserve their branches.
