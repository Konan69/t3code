#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

class LocalBundleError extends Error {}

const fail = (message) => {
  throw new LocalBundleError(`[local-bundle] ${message}`);
};

const [buildRootArg, resourcesArg, linuxCliArchiveArg] = process.argv.slice(2);
if (buildRootArg === undefined || resourcesArg === undefined || linuxCliArchiveArg === undefined) {
  fail(
    "usage: install-local-windows-bundle.cjs <build-root> <installed-resources-dir> <linux-cli-archive>",
  );
}

const buildRoot = path.resolve(buildRootArg);
const resourcesDir = path.resolve(resourcesArg);
const linuxCliArchive = path.resolve(linuxCliArchiveArg);
const archivePath = path.join(resourcesDir, "app.asar");
const serverArchivePath = path.join(resourcesDir, "server.asar");
const wslRuntimeArchivePath = path.join(resourcesDir, "wsl-runtime.tar.gz");
const wslRuntimeChecksumPath = `${wslRuntimeArchivePath}.sha256`;
const desktopBuild = path.join(buildRoot, "apps", "desktop", "dist-electron");
const serverBuild = path.join(buildRoot, "apps", "server", "dist");
const serverTarget = serverArchivePath;

for (const requiredPath of [
  archivePath,
  serverArchivePath,
  wslRuntimeArchivePath,
  linuxCliArchive,
  desktopBuild,
  serverBuild,
]) {
  if (!fs.existsSync(requiredPath)) {
    fail(`required path does not exist: ${requiredPath}`);
  }
}

const pnpmDirectory = path.join(buildRoot, "node_modules", ".pnpm");
const asarPackageDirectory = fs
  .readdirSync(pnpmDirectory)
  .filter((entry) => entry.startsWith("@electron+asar@"))
  .sort()
  .at(-1);
if (asarPackageDirectory === undefined) {
  fail(`@electron/asar is not installed under ${pnpmDirectory}`);
}

const asarRoot = path.join(
  pnpmDirectory,
  asarPackageDirectory,
  "node_modules",
  "@electron",
  "asar",
);
const asar = require(asarRoot);
const { Pickle } = require(path.join(asarRoot, "lib", "pickle.js"));

const walkFiles = (root) => {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      } else {
        fail(`unsupported build entry: ${absolutePath}`);
      }
    }
  };
  visit(root);
  return files.sort();
};

const getHeaderNode = (header, archiveRelativePath) => {
  let node = header;
  for (const component of archiveRelativePath.split("/")) {
    node = node.files?.[component];
    if (node === undefined) {
      fail(`installed archive has no entry for ${archiveRelativePath}`);
    }
  }
  return node;
};

const fileIntegrity = (content) => {
  const blockSize = 4 * 1024 * 1024;
  const blocks = [];
  if (content.length === 0) {
    blocks.push(crypto.createHash("sha256").update(content).digest("hex"));
  } else {
    for (let offset = 0; offset < content.length; offset += blockSize) {
      blocks.push(
        crypto
          .createHash("sha256")
          .update(content.subarray(offset, Math.min(offset + blockSize, content.length)))
          .digest("hex"),
      );
    }
  }
  return {
    algorithm: "SHA256",
    hash: crypto.createHash("sha256").update(content).digest("hex"),
    blockSize,
    blocks,
  };
};

const encodeHeader = (header) => {
  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(JSON.stringify(header));
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);
  return [sizePickle.toBuffer(), headerBuffer];
};

const rewriteArchiveSubtree = ({ sourceArchive, archiveRoot, buildDirectory, stagedArchive }) => {
  const rawHeader = asar.getRawHeader(sourceArchive);
  const archiveBuffer = fs.readFileSync(sourceArchive);
  const packedDataStart = 8 + rawHeader.headerSize;
  const packedData = archiveBuffer.subarray(packedDataStart);
  const subtree = getHeaderNode(rawHeader.header, archiveRoot);
  if (subtree.files === undefined) {
    fail(`installed archive entry is not a directory: ${archiveRoot}`);
  }

  const replacementFiles = {};
  const replacements = [];
  let nextOffset = BigInt(packedData.length);

  for (const buildFile of walkFiles(buildDirectory)) {
    const relativePath = path.relative(buildDirectory, buildFile).split(path.sep).join("/");
    const components = relativePath.split("/");
    const fileName = components.pop();
    if (fileName === undefined) {
      fail(`could not resolve archive path for ${buildFile}`);
    }

    let directory = replacementFiles;
    for (const component of components) {
      const existing = directory[component];
      if (existing === undefined) {
        directory[component] = { files: {} };
      } else if (existing.files === undefined) {
        fail(`archive build path collides with a file: ${relativePath}`);
      }
      directory = directory[component].files;
    }

    const content = fs.readFileSync(buildFile);
    directory[fileName] = {
      size: content.length,
      offset: nextOffset.toString(),
      integrity: fileIntegrity(content),
    };
    nextOffset += BigInt(content.length);
    replacements.push(content);
  }

  subtree.files = replacementFiles;
  const [sizeBuffer, headerBuffer] = encodeHeader(rawHeader.header);
  fs.writeFileSync(
    stagedArchive,
    Buffer.concat([sizeBuffer, headerBuffer, packedData, ...replacements]),
  );
};

const runTar = (args, options = {}) => {
  const result = spawnSync("tar", args, {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    fail(`tar ${args.join(" ")} failed: ${result.stderr?.toString("utf8").trim()}`);
  }
  return result.stdout;
};

const sha256File = (filePath) =>
  crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

const T3_CONNECT_MARKERS = ["pk_live_", "t3-relay", "relay.t3.codes", "hzxSgY2cH10sDU2r"];
const WSL_OVERLAY_MARKERS = [
  "relay.t3.codes",
  "hzxSgY2cH10sDU2r",
  "pi --mode rpc",
  "MachineService",
];

const verifyMarkers = (contents, markers, source) => {
  const combined = contents.join("\n");
  for (const marker of markers) {
    if (!combined.includes(marker)) {
      fail(`${source} is missing marker: ${marker}`);
    }
  }
};

const verifyAsarClientAssets = (candidateArchive, source) => {
  const assetPaths = asar.listPackage(candidateArchive).filter((entry) => {
    const normalized = entry.replace(/^\/+/, "");
    return normalized.startsWith("apps/server/dist/client/assets/") && normalized.endsWith(".js");
  });
  if (assetPaths.length === 0) {
    fail(`${source} has no client/assets/*.js entries`);
  }
  verifyMarkers(
    assetPaths.map((entry) =>
      asar.extractFile(candidateArchive, entry.replace(/^\/+/, "")).toString("utf8"),
    ),
    T3_CONNECT_MARKERS,
    `${source} client assets`,
  );
};

const archiveEntries = (archive) =>
  runTar(["-tzf", archive])
    .toString("utf8")
    .split(/\r?\n/)
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter(Boolean);

const validateLinuxCliArchive = (archive) => {
  const entries = archiveEntries(archive);
  const topLevelNames = new Set(entries.map((entry) => entry.split("/")[0]).filter(Boolean));
  if (topLevelNames.size !== 1) {
    fail("Linux CLI archive must contain exactly one top-level directory");
  }
  const [topLevelName] = topLevelNames;
  if (topLevelName === undefined || !/^t3-.+-linux-x64$/.test(topLevelName)) {
    fail("Linux CLI archive top-level directory must match t3-*-linux-x64/");
  }
  const topLevelDirectory = `${topLevelName}/`;
  if (!entries.includes(topLevelDirectory)) {
    fail(`Linux CLI archive is missing its top-level directory: ${topLevelDirectory}`);
  }
  if (entries.some((entry) => !entry.startsWith(topLevelDirectory))) {
    fail("Linux CLI archive contains entries outside its top-level directory");
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-linux-cli-"));
  try {
    runTar(["-xzf", archive, "-C", temporaryDirectory, "--strip-components=1"]);
    const executable = path.join(temporaryDirectory, "t3");
    if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
      fail("Linux CLI archive is missing its t3 executable");
    }
    if ((fs.statSync(executable).mode & 0o111) === 0) {
      fail("Linux CLI archive t3 is not executable");
    }

    const version = spawnSync(executable, ["--version"], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    if (version.error !== undefined || version.status !== 0) {
      fail(
        `Linux CLI archive t3 --version failed: ${version.error?.message ?? version.stderr?.trim() ?? `exit ${version.status}`}`,
      );
    }

    const assetsDirectory = path.join(temporaryDirectory, "client", "assets");
    if (!fs.existsSync(assetsDirectory) || !fs.statSync(assetsDirectory).isDirectory()) {
      fail("Linux CLI archive is missing client/assets/");
    }
    const assetFiles = fs
      .readdirSync(assetsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => path.join(assetsDirectory, entry.name));
    if (assetFiles.length === 0) {
      fail("Linux CLI archive has no client/assets/*.js files");
    }
    verifyMarkers(
      assetFiles.map((file) => fs.readFileSync(file, "utf8")),
      T3_CONNECT_MARKERS,
      "Linux CLI archive client assets",
    );
    verifyMarkers(
      [fs.readFileSync(executable, "latin1")],
      WSL_OVERLAY_MARKERS,
      "Linux CLI archive t3",
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

const nextBackupPath = (target) => {
  const stamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${target}.pre-local-${stamp}`;
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${target}.pre-local-${stamp}-${index}`;
    index += 1;
  }
  return candidate;
};

const verifyDesktopArchive = (candidateArchive) => {
  const main = asar
    .extractFile(candidateArchive, "apps/desktop/dist-electron/main.cjs")
    .toString("utf8");
  const preload = asar
    .extractFile(candidateArchive, "apps/desktop/dist-electron/preload.cjs")
    .toString("utf8");
  for (const marker of [
    "desktop:preview-set-cookie",
    "wsl-runtime",
    "prepareRuntime",
    "isLocalHostIpv4",
  ]) {
    if (!main.includes(marker)) {
      fail(`candidate desktop bundle is missing marker: ${marker}`);
    }
  }
  if (!preload.includes("desktop:preview-set-cookie")) {
    fail("candidate preload bundle is missing the cookie IPC marker");
  }
};

const serverMarkers = [
  "shouldRefreshThreadShellSummary",
  "preview_set_cookie",
  "subscribeChanges",
  "pi --mode rpc",
  "MachineService",
  "claude-bridge",
];

const verifyServerMarkers = (server, source) => {
  for (const marker of serverMarkers) {
    if (!server.includes(marker)) {
      fail(`${source} is missing marker: ${marker}`);
    }
  }
};

const verifyPiMcpExtension = (extension, source) => {
  for (const marker of ["T3_CODE_MCP_ENDPOINT", "registerT3McpTools"]) {
    if (!extension.includes(marker)) {
      fail(`${source} is missing pi MCP marker: ${marker}`);
    }
  }
};

const verifyServerArchive = (candidateArchive) => {
  const server = asar.extractFile(candidateArchive, "apps/server/dist/bin.mjs").toString("utf8");
  verifyServerMarkers(server, "candidate server bundle");
  verifyPiMcpExtension(
    asar
      .extractFile(candidateArchive, "apps/server/dist/provider/pi/t3McpExtension.mjs")
      .toString("utf8"),
    "candidate server bundle",
  );
  verifyAsarClientAssets(candidateArchive, "candidate server bundle");
};

const stagedArchive = path.join(resourcesDir, `.app.asar.local-new-${process.pid}`);
const stagedServerArchive = path.join(resourcesDir, `.server.asar.local-new-${process.pid}`);
const stagedServer = stagedServerArchive;
const stagedWslRuntimeArchive = path.join(
  resourcesDir,
  `.wsl-runtime.tar.gz.local-new-${process.pid}`,
);
const stagedWslRuntimeChecksum = `${stagedWslRuntimeArchive}.sha256`;
const cleanup = () => {
  fs.rmSync(stagedArchive, { force: true });
  fs.rmSync(stagedServer, { recursive: true, force: true });
  fs.rmSync(stagedWslRuntimeArchive, { force: true });
  fs.rmSync(stagedWslRuntimeChecksum, { force: true });
};

let archiveBackup;
let serverBackup;
let wslRuntimeArchiveBackup;
let wslRuntimeChecksumBackup;
let archiveInstalled = false;
let serverInstalled = false;
let wslRuntimeArchiveInstalled = false;
let wslRuntimeChecksumInstalled = false;
let archiveBackupMoved = false;
let serverBackupMoved = false;
let wslRuntimeArchiveBackupMoved = false;
let wslRuntimeChecksumBackupMoved = false;

try {
  console.log("[local-bundle] validating Linux CLI archive");
  validateLinuxCliArchive(linuxCliArchive);

  console.log("[local-bundle] rewriting compiled desktop subtree");
  rewriteArchiveSubtree({
    sourceArchive: archivePath,
    archiveRoot: "apps/desktop/dist-electron",
    buildDirectory: desktopBuild,
    stagedArchive,
  });
  verifyDesktopArchive(stagedArchive);

  console.log("[local-bundle] rewriting compiled server/web archive subtree");
  rewriteArchiveSubtree({
    sourceArchive: serverArchivePath,
    archiveRoot: "apps/server/dist",
    buildDirectory: serverBuild,
    stagedArchive: stagedServer,
  });
  verifyServerArchive(stagedServer);

  console.log("[local-bundle] staging Linux CLI archive byte-for-byte");
  fs.copyFileSync(linuxCliArchive, stagedWslRuntimeArchive);
  if (sha256File(stagedWslRuntimeArchive) !== sha256File(linuxCliArchive)) {
    fail("staged Linux CLI archive is not byte-for-byte identical to the input archive");
  }
  validateLinuxCliArchive(stagedWslRuntimeArchive);
  // DesktopBackendConfiguration parses this sidecar as one bare SHA-256 line.
  fs.writeFileSync(stagedWslRuntimeChecksum, `${sha256File(stagedWslRuntimeArchive)}\n`);

  archiveBackup = nextBackupPath(archivePath);
  serverBackup = nextBackupPath(serverTarget);
  wslRuntimeArchiveBackup = nextBackupPath(wslRuntimeArchivePath);
  if (fs.existsSync(wslRuntimeChecksumPath)) {
    wslRuntimeChecksumBackup = nextBackupPath(wslRuntimeChecksumPath);
  }
  fs.renameSync(archivePath, archiveBackup);
  archiveBackupMoved = true;
  fs.renameSync(stagedArchive, archivePath);
  archiveInstalled = true;
  fs.renameSync(serverTarget, serverBackup);
  serverBackupMoved = true;
  fs.renameSync(stagedServer, serverTarget);
  serverInstalled = true;
  fs.renameSync(wslRuntimeArchivePath, wslRuntimeArchiveBackup);
  wslRuntimeArchiveBackupMoved = true;
  fs.renameSync(stagedWslRuntimeArchive, wslRuntimeArchivePath);
  wslRuntimeArchiveInstalled = true;
  if (wslRuntimeChecksumBackup !== undefined) {
    fs.renameSync(wslRuntimeChecksumPath, wslRuntimeChecksumBackup);
    wslRuntimeChecksumBackupMoved = true;
  }
  fs.renameSync(stagedWslRuntimeChecksum, wslRuntimeChecksumPath);
  wslRuntimeChecksumInstalled = true;

  verifyDesktopArchive(archivePath);
  verifyServerArchive(serverTarget);
  validateLinuxCliArchive(wslRuntimeArchivePath);
  const installedChecksum = fs.readFileSync(wslRuntimeChecksumPath, "utf8").trim();
  if (installedChecksum !== sha256File(wslRuntimeArchivePath)) {
    fail("installed WSL runtime checksum does not match its archive");
  }
  console.log(`[local-bundle] installed; archive backup: ${archiveBackup}`);
  console.log(`[local-bundle] installed; server backup: ${serverBackup}`);
  console.log(`[local-bundle] installed; WSL runtime backup: ${wslRuntimeArchiveBackup}`);
} catch (error) {
  if (wslRuntimeChecksumInstalled) {
    fs.rmSync(wslRuntimeChecksumPath, { force: true });
  }
  if (wslRuntimeChecksumBackupMoved && wslRuntimeChecksumBackup !== undefined) {
    fs.renameSync(wslRuntimeChecksumBackup, wslRuntimeChecksumPath);
  }
  if (wslRuntimeArchiveInstalled) {
    fs.rmSync(wslRuntimeArchivePath, { force: true });
  }
  if (wslRuntimeArchiveBackupMoved && wslRuntimeArchiveBackup !== undefined) {
    fs.renameSync(wslRuntimeArchiveBackup, wslRuntimeArchivePath);
  }
  if (serverInstalled) {
    fs.rmSync(serverTarget, { recursive: true, force: true });
  }
  if (serverBackupMoved && serverBackup !== undefined) {
    fs.renameSync(serverBackup, serverTarget);
  }
  if (archiveInstalled) {
    fs.rmSync(archivePath, { force: true });
  }
  if (archiveBackupMoved && archiveBackup !== undefined) {
    fs.renameSync(archiveBackup, archivePath);
  }
  if (error instanceof LocalBundleError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  cleanup();
}
