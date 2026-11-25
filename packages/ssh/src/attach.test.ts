// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - runs the real shell script against real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import * as SshTunnel from "./tunnel.ts";

// These run the launch script the way the remote host does, against a
// throwaway HOME, so the assertions are about what the script does to a
// server and its records rather than about the text it contains.

const STATE_KEY = "attach-test";
// Stands in for the T3 server and its CLI: `serve` answers 200 on the port
// it is given, and `auth pairing create` mints a credential naming the file
// that ran, so a test can tell whose executable did the pairing.
const FAKE_SERVER = `#!/usr/bin/env node
const http = require("node:http");
if (process.argv[2] === "auth") {
  process.stdout.write(JSON.stringify({ credential: "minted-by:" + __filename }) + "\\n");
} else {
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1");
}
`;

const spawned: number[] = [];
const homes: string[] = [];

afterEach(() => {
  // Only pids this file started or read back from its own throwaway HOME.
  for (const pid of spawned.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const home of homes.splice(0)) NodeFS.rmSync(home, { recursive: true, force: true });
});

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        address !== null && typeof address === "object"
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });

const answers = (port: number) =>
  new Promise<boolean>((resolve) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: 500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    request.once("error", () => resolve(false));
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });

const waitUntilAnswering = async (port: number) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await answers(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Nothing answered on ${port}.`);
};

const makeHome = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-attach-"));
  homes.push(home);
  const stateDir = NodePath.join(home, ".t3", "ssh-launch", STATE_KEY);
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const serverScript = NodePath.join(home, "fake-server.cjs");
  NodeFS.writeFileSync(serverScript, FAKE_SERVER);
  return { home, stateDir, serverScript };
};

/** Records a server the way the client that started it would have. */
const recordServer = (stateDir: string, input: { pid: number; port: number; runner: string }) => {
  NodeFS.writeFileSync(NodePath.join(stateDir, "pid"), `${input.pid}\n`);
  NodeFS.writeFileSync(NodePath.join(stateDir, "port"), `${input.port}\n`);
  NodeFS.writeFileSync(NodePath.join(stateDir, "managed"), "managed\n");
  NodeFS.writeFileSync(NodePath.join(stateDir, "run-t3.sh"), input.runner);
};

const records = (stateDir: string) =>
  Object.fromEntries(
    ["pid", "port", "managed", "run-t3.sh"].map((name) => [
      name,
      NodeFS.readFileSync(NodePath.join(stateDir, name), "utf8"),
    ]),
  );

const launch = (home: string, serverScript: string, preserveRunningServer: boolean) =>
  NodeChildProcess.spawnSync("sh", ["-s", "--", STATE_KEY], {
    input: SshTunnel.buildRemoteLaunchScript({
      nodeScriptPath: serverScript,
      preserveRunningServer,
    }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    timeout: 90_000,
  });

describe("attach-only remote launch", () => {
  it("reuses a live server started by another runner and leaves its records alone", async () => {
    const { home, stateDir, serverScript } = makeHome();
    const port = await freePort();
    const server = NodeChildProcess.spawn(
      process.execPath,
      [serverScript, "serve", "--port", `${port}`],
      {
        stdio: "ignore",
      },
    );
    spawned.push(server.pid!);
    await waitUntilAnswering(port);
    recordServer(stateDir, { pid: server.pid!, port, runner: "#!/bin/sh\n# another version\n" });
    const before = records(stateDir);

    const result = launch(home, serverScript, true);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), {
      remotePort: port,
      serverKind: "managed",
    });
    assert.isTrue(isAlive(server.pid!));
    assert.deepEqual(records(stateDir), before);
  }, 60_000);

  it("the default mode restarts that same server, which is why attach exists", async () => {
    const { home, stateDir, serverScript } = makeHome();
    const port = await freePort();
    const server = NodeChildProcess.spawn(
      process.execPath,
      [serverScript, "serve", "--port", `${port}`],
      {
        stdio: "ignore",
      },
    );
    spawned.push(server.pid!);
    await waitUntilAnswering(port);
    recordServer(stateDir, { pid: server.pid!, port, runner: "#!/bin/sh\n# another version\n" });

    const result = launch(home, serverScript, false);
    spawned.push(Number(NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8")));

    assert.equal(result.status, 0, result.stderr);
    // The script signalled it; the exit is observed once this process reaps it.
    const signal = await new Promise((resolve) => {
      if (server.signalCode !== null || server.exitCode !== null) resolve(server.signalCode);
      else server.once("exit", (_code, exitSignal) => resolve(exitSignal));
    });
    assert.equal(signal, "SIGTERM");
  }, 90_000);

  it("refuses, without killing, a live server that does not answer", async () => {
    const { home, stateDir, serverScript } = makeHome();
    const port = await freePort();
    const hung = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    spawned.push(hung.pid!);
    recordServer(stateDir, { pid: hung.pid!, port, runner: "#!/bin/sh\n# another version\n" });
    const before = records(stateDir);

    const result = launch(home, serverScript, true);

    assert.notEqual(result.status, 0);
    assert.include(result.stderr, "It was left running.");
    assert.isTrue(isAlive(hung.pid!));
    assert.deepEqual(records(stateDir), before);
    assert.isFalse(await answers(port));
  }, 60_000);

  it("fails, and leaves the remote home untouched, when no server is running", () => {
    const { home, stateDir, serverScript } = makeHome();
    // A record left behind by a server that has since exited.
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]);
    recordServer(stateDir, { pid: exited.pid, port: 3773, runner: "#!/bin/sh\n" });
    const tree = () =>
      NodeFS.readdirSync(home, { recursive: true, withFileTypes: true })
        .map((entry) => {
          const path = NodePath.join(entry.parentPath, entry.name);
          return `${path} ${NodeFS.statSync(path).mtimeMs}`;
        })
        .toSorted();
    const before = tree();

    const result = launch(home, serverScript, true);

    assert.equal(result.status, SshTunnel.REMOTE_ATTACH_NOT_RUNNING_EXIT);
    assert.include(result.stderr, "T3 is not running on the remote host.");
    assert.equal(result.stdout, "");
    assert.deepEqual(tree(), before);
  }, 60_000);

  it("leaves a live server's install untouched and pairs through its executable", async () => {
    const { home, stateDir } = makeHome();
    // The live server runs from the very version directory this caller would
    // install into, and that directory has no install-complete marker: the
    // runner's installer would delete and replace it.
    const runtimeDir = NodePath.join(home, ".t3", "runtime", "versions", "1.2.3");
    NodeFS.mkdirSync(NodePath.join(runtimeDir, "client"), { recursive: true });
    const executable = NodePath.join(runtimeDir, "t3");
    NodeFS.writeFileSync(executable, FAKE_SERVER, { mode: 0o755 });
    NodeFS.writeFileSync(NodePath.join(runtimeDir, "client", "index.html"), "<html></html>");
    const installed = [runtimeDir, executable, NodePath.join(runtimeDir, "client", "index.html")];
    const identity = () =>
      installed.map((path) => {
        const stat = NodeFS.statSync(path);
        return [path, stat.ino, stat.mtimeMs];
      });

    const port = await freePort();
    const server = NodeChildProcess.spawn(executable, ["serve", "--port", `${port}`], {
      stdio: "ignore",
    });
    spawned.push(server.pid!);
    await waitUntilAnswering(port);
    recordServer(stateDir, { pid: server.pid!, port, runner: "#!/bin/sh\n# another client\n" });
    const before = {
      records: records(stateDir),
      files: NodeFS.readdirSync(stateDir),
      identity: identity(),
    };

    // An unreachable release URL: any attempt to install would fail the script.
    const guest = {
      archiveVersion: "1.2.3",
      releaseBaseUrl: "http://127.0.0.1:1/releases",
      preserveRunningServer: true,
    };
    const run = (script: string, args: ReadonlyArray<string>) =>
      NodeChildProcess.spawnSync("sh", ["-s", ...args], {
        input: script,
        env: { ...process.env, HOME: home },
        encoding: "utf8",
        timeout: 60_000,
      });
    const attached = run(SshTunnel.buildRemoteLaunchScript(guest), ["--", STATE_KEY]);
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
    // The pairing script keys its state directory off the target, so point
    // that directory at the one the launch used.
    const pairingScript = SshTunnel.buildRemotePairingScript(target, guest).replace(
      /ssh-launch\/[0-9a-f]+"/u,
      `ssh-launch/${STATE_KEY}"`,
    );
    const paired = run(pairingScript, []);

    assert.equal(attached.status, 0, attached.stderr);
    assert.equal(JSON.parse(attached.stdout.trim()).remotePort, port);
    assert.equal(paired.status, 0, paired.stderr);
    assert.deepEqual(JSON.parse(paired.stdout.trim()), { credential: `minted-by:${executable}` });
    assert.isTrue(isAlive(server.pid!));
    assert.deepEqual(identity(), before.identity);
    assert.deepEqual(records(stateDir), before.records);
    assert.deepEqual(NodeFS.readdirSync(stateDir), before.files);
    assert.deepEqual(NodeFS.readdirSync(NodePath.dirname(runtimeDir)), ["1.2.3"]);
  }, 60_000);
});
