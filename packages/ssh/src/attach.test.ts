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
// Stands in for the T3 server: answers 200 on the port the runner passes.
const FAKE_SERVER = `const http = require("node:http");
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((_request, response) => response.end("ok")).listen(port, "127.0.0.1");
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
    const server = NodeChildProcess.spawn(process.execPath, [serverScript, "--port", `${port}`], {
      stdio: "ignore",
    });
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
    const server = NodeChildProcess.spawn(process.execPath, [serverScript, "--port", `${port}`], {
      stdio: "ignore",
    });
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

  it("starts a server when none is alive", async () => {
    const { home, stateDir, serverScript } = makeHome();
    // A record left behind by a server that has since exited.
    const exited = NodeChildProcess.spawnSync(process.execPath, ["-e", ""]);
    recordServer(stateDir, { pid: exited.pid, port: await freePort(), runner: "#!/bin/sh\n" });

    const result = launch(home, serverScript, true);
    const pid = Number(NodeFS.readFileSync(NodePath.join(stateDir, "pid"), "utf8"));
    spawned.push(pid);

    assert.equal(result.status, 0, result.stderr);
    const launched = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(launched.serverKind, "managed");
    assert.isTrue(isAlive(pid));
    assert.isTrue(await answers(launched.remotePort));
    // The server it started is recorded under the shared runner file, so a
    // later client sending the same runner reuses it.
    assert.equal(
      NodeFS.readFileSync(NodePath.join(stateDir, "run-t3.sh"), "utf8"),
      NodeFS.readFileSync(NodePath.join(stateDir, "run-t3.attach.sh"), "utf8"),
    );
  }, 90_000);

  it("pairing in attach mode leaves the owner's runner record alone", () => {
    const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
    const runner = { nodeScriptPath: "/srv/t3/bin.mjs" };
    const attach = SshTunnel.buildRemotePairingScript(target, {
      ...runner,
      preserveRunningServer: true,
    });
    assert.include(attach, 'RUNNER_FILE="$STATE_DIR/run-t3.attach.sh"');
    assert.include(
      SshTunnel.buildRemotePairingScript(target, runner),
      'RUNNER_FILE="$STATE_DIR/run-t3.sh"',
    );
  });
});
