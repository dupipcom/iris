#!/usr/bin/env node
/**
 * Verify that every release metadata file (latest*.yml) in the release output
 * matches the actual build artifacts on disk (sha512 + size + blockmap size).
 *
 * Parses with js-yaml (not line regexes) so folded/wrapped sha512 lines that
 * electron-builder emits are handled correctly.
 *
 * electron-updater trusts the checksums published in these yml files. If an
 * installer is rebuilt / re-signed after the yml was generated (or the two are
 * copied from different machines/builds), updates fail with:
 *   "App download failed: sha512 checksum mismatch, expected ..., got ..."
 *
 * Usage: node scripts/verify-release.js [release-dir]
 * Defaults to ./release. Exits non-zero if any artifact mismatches, so it can
 * be run as a pre-upload gate (e.g. before attaching assets to a GitHub release).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");

const dir = path.resolve(process.argv[2] || "release");
if (!fs.existsSync(dir)) {
  console.error(`❌ Release directory not found: ${dir}`);
  process.exit(2);
}

function sha512Base64(file) {
  return crypto
    .createHash("sha512")
    .update(fs.readFileSync(file))
    .digest("base64");
}

let failures = 0;
const metas = fs
  .readdirSync(dir)
  .filter((f) => /^latest.*\.yml$/.test(f))
  .sort();

if (metas.length === 0) {
  console.error(`❌ No latest*.yml metadata found in ${dir}`);
  process.exit(2);
}

function checkEntry(label, artifact, ymlSha, ymlSize, ymlBlockMapSize, checkBlockMap = true) {
  if (!fs.existsSync(artifact)) {
    console.error(`❌ [${label}] missing artifact: ${artifact}`);
    failures++;
    return;
  }
  const actualHash = sha512Base64(artifact);
  const actualSize = fs.statSync(artifact).size;
  const bmPath = artifact + ".blockmap";
  const actualBlockMapSize = fs.existsSync(bmPath) ? fs.statSync(bmPath).size : undefined;

  const shaOk = actualHash === ymlSha;
  const sizeOk = actualSize === ymlSize;
  const bmOk = !checkBlockMap || (ymlBlockMapSize ?? undefined) === actualBlockMapSize;

  if (shaOk && sizeOk && bmOk) {
    console.log(`✅ [${label}] ${path.basename(artifact)}`);
    return;
  }

  console.error(`❌ [${label}] ${path.basename(artifact)}`);
  if (!shaOk) {
    console.error(`   sha512 yml: ${ymlSha}`);
    console.error(`   sha512 now: ${actualHash}`);
  }
  if (!sizeOk) {
    console.error(`   size   yml: ${ymlSize}`);
    console.error(`   size   now: ${actualSize}`);
  }
  if (!bmOk) {
    console.error(`   blockMapSize yml: ${ymlBlockMapSize}`);
    console.error(`   blockMapSize now: ${actualBlockMapSize}`);
  }
  failures++;
}

for (const meta of metas) {
  const data = yaml.load(fs.readFileSync(path.join(dir, meta), "utf8"));
  for (const entry of data.files || []) {
    checkEntry(meta, path.join(dir, entry.url), entry.sha512, entry.size, entry.blockMapSize);
  }
  if (data.path) {
    // Top-level entries don't carry a blockmap size; only check sha512 + size.
    checkEntry(`${meta} (path)`, path.join(dir, data.path), data.sha512, data.size, undefined, false);
  }
}

if (failures === 0) {
  console.log("\n✅ All release metadata matches the artifacts.");
  process.exit(0);
} else {
  console.error(
    `\n❌ ${failures} mismatch(es) — rebuild cleanly so the yml, installers and ` +
      `.blockmap files all come from the same run, then re-upload them together.`
  );
  process.exit(1);
}
