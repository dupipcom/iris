#!/usr/bin/env node
/**
 * Regenerate SHA512 checksums, sizes and blockmap sizes in all latest*.yml
 * files from the actual binary artifacts on disk. Use this when the yml files
 * got out of sync with the installers (e.g. after a cross-platform rebuild or
 * a re-sign).
 *
 * Parses with js-yaml (not regex) so the folded/wrapped sha512 lines that
 * electron-builder emits are handled correctly.
 *
 * Usage: node scripts/fix-release-checksums.js [release-dir]
 * Defaults to ./release.
 *
 * After running this, verify with: node scripts/verify-release.js
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

/** Size in bytes of the sidecar .blockmap for an artifact, or undefined. */
function blockMapSizeFor(artifact) {
  const bm = artifact + ".blockmap";
  return fs.existsSync(bm) ? fs.statSync(bm).size : undefined;
}

const yamlFiles = fs
  .readdirSync(dir)
  .filter((f) => /^latest.*\.yml$/.test(f))
  .sort();

if (yamlFiles.length === 0) {
  console.error(`❌ No latest*.yml files found in ${dir}`);
  process.exit(2);
}

let totalFixed = 0;
let totalCorrect = 0;
let totalMissing = 0;

for (const meta of yamlFiles) {
  const metaPath = path.join(dir, meta);
  const data = yaml.load(fs.readFileSync(metaPath, "utf8"));
  let fixed = 0;
  let correct = 0;
  let missing = 0;

  // Fix every `files:` entry.
  for (const entry of data.files || []) {
    const artifact = path.join(dir, entry.url);
    if (!fs.existsSync(artifact)) {
      console.error(`⚠️  [${meta}] Missing artifact, leaving entry unchanged: ${entry.url}`);
      missing++;
      continue;
    }

    const actualSha = sha512Base64(artifact);
    const actualSize = fs.statSync(artifact).size;
    const actualBlockMapSize = blockMapSizeFor(artifact);

    if (
      entry.sha512 === actualSha &&
      entry.size === actualSize &&
      entry.blockMapSize === actualBlockMapSize
    ) {
      correct++;
      continue;
    }

    fixed++;
    console.log(`🔧 [${meta}] ${entry.url}`);
    entry.sha512 = actualSha;
    entry.size = actualSize;
    if (actualBlockMapSize !== undefined) {
      entry.blockMapSize = actualBlockMapSize;
    } else {
      delete entry.blockMapSize; // no local blockmap → don't advertise one
    }
  }

  // Fix the top-level path/sha512/size (the "default" artifact).
  if (data.path) {
    const topArtifact = path.join(dir, data.path);
    if (fs.existsSync(topArtifact)) {
      const actualSha = sha512Base64(topArtifact);
      const actualSize = fs.statSync(topArtifact).size;
      if (data.sha512 !== actualSha || data.size !== actualSize) {
        fixed++;
        console.log(`🔧 [${meta}] top-level ${data.path}`);
        data.sha512 = actualSha;
        data.size = actualSize;
      } else {
        correct++;
      }
    } else {
      missing++;
    }
  }

  // Write back. lineWidth: -1 keeps long base64 hashes on one line (valid YAML).
  fs.writeFileSync(metaPath, yaml.dump(data, { lineWidth: -1 }), "utf8");
  console.log(
    `✅ [${meta}] ${fixed ? `fixed ${fixed}` : "no changes"}, ${correct} already correct, ${missing} missing`
  );

  totalFixed += fixed;
  totalCorrect += correct;
  totalMissing += missing;
}

console.log(
  `\n📊 Summary: ${totalFixed} fixed, ${totalCorrect} already correct, ${totalMissing} missing artifacts`
);
if (totalMissing > 0) {
  console.warn("⚠️  Missing artifacts were left unchanged in the yml files.");
}
if (totalFixed === 0 && totalMissing === 0) {
  console.log("✅ All checksums already match the artifacts.");
}
