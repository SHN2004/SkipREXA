import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const projectRoot = process.cwd();
const distDir = path.join(projectRoot, "dist");
const manifestPath = path.join(projectRoot, "manifest.json");
const releasesDir = path.join(projectRoot, "releases");

if (!existsSync(distDir)) {
  throw new Error("dist/ does not exist. Run the build step before packaging.");
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const extensionName = String(manifest.name ?? "extension")
  .trim()
  .replace(/\s+/g, "-")
  .replace(/[^a-zA-Z0-9-_]/g, "");
const version = String(manifest.version ?? "0.0.0").trim();
const archiveName = `${extensionName}-v${version}-chrome.zip`;
const archivePath = path.join(releasesDir, archiveName);

mkdirSync(releasesDir, { recursive: true });
rmSync(archivePath, { force: true });

try {
  execFileSync("zip", ["-qr", archivePath, "."], {
    cwd: distDir,
    stdio: "inherit",
  });
} catch (error) {
  throw new Error(
    `Failed to create ${archiveName}. Ensure the 'zip' command is available on this machine.`,
    { cause: error },
  );
}

console.log(`Created ${path.relative(projectRoot, archivePath)}`);
