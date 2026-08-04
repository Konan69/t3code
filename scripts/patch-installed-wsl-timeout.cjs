#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const archivePath = process.argv[2];
if (!archivePath) {
  throw new Error("Usage: patch-installed-wsl-timeout.cjs <path-to-app.asar>");
}

const repositoryRoot = path.resolve(__dirname, "..");
const pnpmModules = path.join(repositoryRoot, "node_modules", ".pnpm");
const asarPackageDirectory = fs
  .readdirSync(pnpmModules)
  .find((entry) => entry.startsWith("@electron+asar@"));
if (!asarPackageDirectory) {
  throw new Error("@electron/asar is not installed in this workspace");
}

const asarRoot = path.join(pnpmModules, asarPackageDirectory, "node_modules", "@electron", "asar");
const asar = require(asarRoot);
const disk = require(path.join(asarRoot, "lib", "disk.js"));
const { Pickle } = require(path.join(asarRoot, "lib", "pickle.js"));

const mainPath = "apps/desktop/dist-electron/main.cjs";
const replacements = [
  {
    name: "WSL probe timeout",
    before: Buffer.from("const PROBE_TIMEOUT = effect_Duration.seconds(10);"),
    after: Buffer.from("const PROBE_TIMEOUT = effect_Duration.seconds(60);"),
  },
  {
    name: "mirrored-network renderer host",
    before: Buffer.from("onSome: (ip) => isLocalHostIpv4(ip)"),
    after: Buffer.from("onSome: (ip) => true               "),
  },
];
for (const replacement of replacements) {
  if (replacement.before.length !== replacement.after.length) {
    throw new Error(`${replacement.name} replacement must preserve the ASAR entry size`);
  }
}

const findEntry = (header, relativePath) =>
  relativePath.split("/").reduce((entry, segment) => entry?.files?.[segment], header);

const hash = (contents) => crypto.createHash("sha256").update(contents).digest("hex");
const patchArchive = (targetPath) => {
  const archive = disk.readArchiveHeaderSync(targetPath);
  const entry = findEntry(archive.header, mainPath);
  if (!entry || entry.unpacked || typeof entry.offset !== "string") {
    throw new Error(`Packed ASAR entry not found: ${mainPath}`);
  }

  const descriptor = fs.openSync(targetPath, "r+");
  try {
    const contents = Buffer.alloc(entry.size);
    const dataOffset = 8 + archive.headerSize + Number(entry.offset);
    fs.readSync(descriptor, contents, 0, contents.length, dataOffset);

    const statuses = [];
    let changed = false;
    for (const replacement of replacements) {
      const firstMatch = contents.indexOf(replacement.before);
      if (firstMatch < 0) {
        if (contents.indexOf(replacement.after) >= 0) {
          statuses.push(`${replacement.name}: already-patched`);
          continue;
        }
        throw new Error(`Expected ${replacement.name} pattern was not found`);
      }
      if (contents.indexOf(replacement.before, firstMatch + replacement.before.length) >= 0) {
        throw new Error(
          `More than one ${replacement.name} pattern matched; refusing an ambiguous patch`,
        );
      }

      replacement.after.copy(contents, firstMatch);
      changed = true;
      statuses.push(`${replacement.name}: patched`);
    }

    if (!changed) return statuses;

    const blockSize = entry.integrity?.blockSize ?? 4 * 1024 * 1024;
    const blocks = [];
    for (let offset = 0; offset < contents.length; offset += blockSize) {
      blocks.push(hash(contents.subarray(offset, offset + blockSize)));
    }
    entry.integrity = {
      algorithm: "SHA256",
      hash: hash(contents),
      blockSize,
      blocks,
    };

    const headerPickle = Pickle.createEmpty();
    headerPickle.writeString(JSON.stringify(archive.header));
    const headerBuffer = headerPickle.toBuffer();
    if (headerBuffer.length !== archive.headerSize) {
      throw new Error("Patched ASAR header changed size; refusing a non-atomic rewrite");
    }

    fs.writeSync(descriptor, headerBuffer, 0, headerBuffer.length, 8);
    fs.writeSync(descriptor, contents, 0, contents.length, dataOffset);
    fs.fsyncSync(descriptor);
    return statuses;
  } finally {
    fs.closeSync(descriptor);
  }
};

const temporaryPath = `${archivePath}.wsl-timeout-${process.pid}.tmp`;
fs.copyFileSync(archivePath, temporaryPath, fs.constants.COPYFILE_EXCL);

try {
  const statuses = patchArchive(temporaryPath);
  asar.uncacheAll();
  const patchedMain = asar.extractFile(temporaryPath, mainPath);
  for (const replacement of replacements) {
    if (!patchedMain.includes(replacement.after) || patchedMain.includes(replacement.before)) {
      throw new Error(`Patched ASAR failed ${replacement.name} verification`);
    }
  }

  const changed = statuses.some((status) => status.endsWith(": patched"));
  if (!changed) {
    fs.rmSync(temporaryPath);
    process.stdout.write(`${statuses.join("\n")}\narchive already patched: ${archivePath}\n`);
    process.exit(0);
  }

  const backupBasePath = `${archivePath}.pre-wsl-hotpatch`;
  let backupPath = backupBasePath;
  for (let suffix = 1; fs.existsSync(backupPath); suffix += 1) {
    backupPath = `${backupBasePath}.${suffix}`;
  }
  fs.copyFileSync(archivePath, backupPath, fs.constants.COPYFILE_EXCL);
  fs.renameSync(temporaryPath, archivePath);
  process.stdout.write(`${statuses.join("\n")}\narchive: ${archivePath}\nbackup: ${backupPath}\n`);
} catch (error) {
  fs.rmSync(temporaryPath, { force: true });
  process.stderr.write(`Patch failed; original archive is unchanged: ${String(error)}\n`);
  process.exitCode = 1;
}
