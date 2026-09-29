const fs = require("node:fs/promises");
const path = require("node:path");

function parseRepository(repository) {
  const parts = repository.trim().split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid desktop detection repository: ${repository}`);
  }
  return { owner: parts[0], repo: parts[1] };
}

async function rewriteAppUpdateFile(resourcesDir, repository) {
  const { owner, repo } = parseRepository(repository);
  const appUpdatePath = path.join(resourcesDir, "app-update.yml");
  const source = await fs.readFile(appUpdatePath, "utf8");
  let sawOwner = false;
  let sawRepo = false;
  const lines = [];
  let skippingPublisherName = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^publisherName:/.test(line)) {
      skippingPublisherName = true;
      continue;
    }
    if (skippingPublisherName && /^\s+/.test(line)) continue;
    skippingPublisherName = false;
    if (/^owner:/.test(line)) {
      sawOwner = true;
      lines.push(`owner: ${owner}`);
    } else if (/^repo:/.test(line)) {
      sawRepo = true;
      lines.push(`repo: ${repo}`);
    } else {
      lines.push(line);
    }
  }
  if (!sawOwner || !sawRepo) {
    throw new Error(`Packaged app-update.yml is not a GitHub feed: ${appUpdatePath}`);
  }
  await fs.writeFile(appUpdatePath, lines.join("\n"), "utf8");
}

async function rewriteDesktopAppUpdate(context) {
  const repository = process.env.T3CODE_DESKTOP_DETECTION_REPOSITORY?.trim();
  if (!repository) return;
  const resourcesDir =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  await rewriteAppUpdateFile(resourcesDir, repository);
}

rewriteDesktopAppUpdate.parseRepository = parseRepository;
rewriteDesktopAppUpdate.rewriteAppUpdateFile = rewriteAppUpdateFile;
module.exports = rewriteDesktopAppUpdate;
