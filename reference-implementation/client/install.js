#!/usr/bin/env node
/**
 * Reference client for the git-free HTTP marketplace distribution spec
 * (see spec/agent-marketplace-distribution-spec-draft.md, section 8).
 *
 * This stands in for what a real agent CLI's plugin installer would do.
 * No existing CLI (Copilot, Claude Code) speaks this protocol today — this
 * script exists to prove the protocol itself is implementable end-to-end
 * (manifest fetch -> per-plugin detail doc fetch -> auth -> artifact
 * download -> checksum verify -> extract), independent of any particular
 * vendor adopting it. Updated for spec v0.2's two-tier manifest: the
 * lightweight index (`marketplace.json`) no longer carries `versions[]`
 * inline, so the client fetches `plugins/{name}.json` (§4a) to resolve a
 * version/artifact before downloading.
 *
 * Usage:
 *   node http-marketplace/client/install.js <marketplace-base-url> <plugin-name> [token] [install-dir]
 *
 * Example:
 *   node http-marketplace/client/install.js http://localhost:8090 sample-plugin demo-token-123 /tmp/plugin-store
 */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const [, , baseUrlArg, pluginName, token, installDirArg] = process.argv;

if (!baseUrlArg || !pluginName) {
  console.error(
    "Usage: install.js <marketplace-base-url> <plugin-name> [token] [install-dir]"
  );
  process.exit(2);
}

const baseUrl = baseUrlArg.endsWith("/") ? baseUrlArg : baseUrlArg + "/";
const installDir = installDirArg || path.join(os.tmpdir(), "http-marketplace-plugin-store");

function fetch(url, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const headers = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    mod
      .get(url, { headers }, (res) => {
        if (res.statusCode === 401) {
          reject(new Error(`401 Unauthorized fetching ${url} (${res.headers["www-authenticate"] || ""})`));
          res.resume();
          return;
        }
        if (res.statusCode === 403) {
          reject(new Error(`403 Forbidden fetching ${url}`));
          res.resume();
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Unexpected status ${res.statusCode} fetching ${url}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve(binary ? buf : buf.toString("utf8"));
        });
      })
      .on("error", reject);
  });
}

async function main() {
  console.log(`[1/7] GET ${baseUrl}marketplace.json`);
  const manifestRaw = await fetch(baseUrl + "marketplace.json");
  const manifest = JSON.parse(manifestRaw);
  console.log(`      marketplace: "${manifest.name}" (specVersion ${manifest.specVersion})`);

  const pluginSummary = (manifest.plugins || []).find((p) => p.name === pluginName);
  if (!pluginSummary) {
    throw new Error(`Plugin "${pluginName}" not found in marketplace "${manifest.name}"`);
  }

  const detailUrl = new URL(`./plugins/${pluginSummary.name}.json`, baseUrl).toString();
  console.log(`[2/7] GET ${detailUrl}`);
  const detailRaw = await fetch(detailUrl);
  const detail = JSON.parse(detailRaw);

  const version = detail.versions.find((v) => v.version === pluginSummary.latestVersion);
  if (!version) throw new Error(`latestVersion ${pluginSummary.latestVersion} not found in ${detailUrl} versions[]`);
  if (version.yanked) {
    throw new Error(`Version ${version.version} of ${pluginName} is yanked: ${version.yankedReason}`);
  }
  console.log(`[3/7] Resolved ${pluginName}@${version.version}`);

  const artifactUrl = new URL(version.artifact.url, detailUrl).toString();
  console.log(`[4/7] GET ${artifactUrl}`);
  const artifactBuf = await fetch(artifactUrl, { binary: true });
  console.log(`      downloaded ${artifactBuf.length} bytes`);

  console.log(`[5/7] Verifying sha256 checksum`);
  const actualSha256 = crypto.createHash("sha256").update(artifactBuf).digest("hex");
  if (actualSha256 !== version.artifact.sha256) {
    throw new Error(
      `Checksum mismatch! expected ${version.artifact.sha256}, got ${actualSha256}`
    );
  }
  console.log(`      sha256 OK (${actualSha256})`);

  const destDir = path.join(installDir, manifest.name, pluginName, version.version);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });

  const tmpTar = path.join(os.tmpdir(), `${pluginName}-${version.version}-${Date.now()}.tar.gz`);
  fs.writeFileSync(tmpTar, artifactBuf);

  console.log(`[6/7] Extracting to ${destDir}`);
  execFileSync("tar", ["-xzf", tmpTar, "-C", destDir]);
  fs.unlinkSync(tmpTar);

  const registryFile = path.join(installDir, "installed.json");
  let installed = {};
  if (fs.existsSync(registryFile)) {
    installed = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  }
  installed[`${pluginName}@${manifest.name}`] = {
    version: version.version,
    sha256: actualSha256,
    installedAt: new Date().toISOString(),
    path: destDir,
  };
  fs.writeFileSync(registryFile, JSON.stringify(installed, null, 2));

  console.log(`[7/7] Done. Installed plugin files:`);
  for (const f of fs.readdirSync(destDir, { recursive: true })) {
    console.log(`      ${f}`);
  }
}

main().catch((err) => {
  console.error(`Install failed: ${err.message}`);
  process.exit(1);
});
