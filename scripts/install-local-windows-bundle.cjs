#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const fail = (message) => {
  console.error(`[local-bundle] ${message}`);
  process.exit(1);
};

const [buildRootArg, resourcesArg] = process.argv.slice(2);
if (buildRootArg === undefined || resourcesArg === undefined) {
  fail("usage: install-local-windows-bundle.cjs <build-root> <installed-resources-dir>");
}

const buildRoot = path.resolve(buildRootArg);
const resourcesDir = path.resolve(resourcesArg);
const archivePath = path.join(resourcesDir, "app.asar");
const serverArchivePath = path.join(resourcesDir, "server.asar");
const desktopBuild = path.join(buildRoot, "apps", "desktop", "dist-electron");
const serverBuild = path.join(buildRoot, "apps", "server", "dist");
const legacyServerTarget = path.join(`${archivePath}.unpacked`, "apps", "server", "dist");
const usesServerArchive = fs.existsSync(serverArchivePath);
const serverTarget = usesServerArchive ? serverArchivePath : legacyServerTarget;

for (const requiredPath of [archivePath, desktopBuild, serverBuild, serverTarget]) {
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

const verifyServerArchive = (candidateArchive) => {
  const server = asar.extractFile(candidateArchive, "apps/server/dist/bin.mjs").toString("utf8");
  for (const marker of [
    "shouldRefreshThreadShellSummary",
    "preview_set_cookie",
    "subscribeChanges",
    "pi --mode rpc",
    "MachineService",
    "claude-bridge",
  ]) {
    if (!server.includes(marker)) {
      fail(`candidate server bundle is missing marker: ${marker}`);
    }
  }
};

const verifyLegacyServer = (candidateDirectory) => {
  const serverEntry = path.join(candidateDirectory, "bin.mjs");
  if (!fs.existsSync(serverEntry) || fs.statSync(serverEntry).size === 0) {
    fail(`server bundle is missing: ${serverEntry}`);
  }
};

const stagedArchive = path.join(resourcesDir, `.app.asar.local-new-${process.pid}`);
const stagedServerArchive = path.join(resourcesDir, `.server.asar.local-new-${process.pid}`);
const stagedLegacyServer = path.join(
  path.dirname(legacyServerTarget),
  `.dist.local-new-${process.pid}`,
);
const stagedServer = usesServerArchive ? stagedServerArchive : stagedLegacyServer;
const cleanup = () => {
  fs.rmSync(stagedArchive, { force: true });
  fs.rmSync(stagedServer, { recursive: true, force: true });
};

let archiveBackup;
let serverBackup;
let archiveInstalled = false;
let serverInstalled = false;

try {
  console.log("[local-bundle] rewriting compiled desktop subtree");
  rewriteArchiveSubtree({
    sourceArchive: archivePath,
    archiveRoot: "apps/desktop/dist-electron",
    buildDirectory: desktopBuild,
    stagedArchive,
  });
  verifyDesktopArchive(stagedArchive);

  if (usesServerArchive) {
    console.log("[local-bundle] rewriting compiled server/web archive subtree");
    rewriteArchiveSubtree({
      sourceArchive: serverArchivePath,
      archiveRoot: "apps/server/dist",
      buildDirectory: serverBuild,
      stagedArchive: stagedServer,
    });
    verifyServerArchive(stagedServer);
  } else {
    console.log("[local-bundle] staging legacy compiled server/web directory");
    fs.cpSync(serverBuild, stagedServer, { recursive: true, dereference: false });
    verifyLegacyServer(stagedServer);
  }

  archiveBackup = nextBackupPath(archivePath);
  serverBackup = nextBackupPath(serverTarget);
  fs.renameSync(archivePath, archiveBackup);
  fs.renameSync(stagedArchive, archivePath);
  archiveInstalled = true;
  fs.renameSync(serverTarget, serverBackup);
  fs.renameSync(stagedServer, serverTarget);
  serverInstalled = true;

  verifyDesktopArchive(archivePath);
  if (usesServerArchive) {
    verifyServerArchive(serverTarget);
  } else {
    verifyLegacyServer(serverTarget);
  }
  console.log(`[local-bundle] installed; archive backup: ${archiveBackup}`);
  console.log(`[local-bundle] installed; server backup: ${serverBackup}`);
} catch (error) {
  if (serverInstalled && serverBackup !== undefined) {
    fs.rmSync(serverTarget, { recursive: true, force: true });
    fs.renameSync(serverBackup, serverTarget);
  }
  if (archiveInstalled && archiveBackup !== undefined) {
    fs.rmSync(archivePath, { force: true });
    fs.renameSync(archiveBackup, archivePath);
  }
  throw error;
} finally {
  cleanup();
}
