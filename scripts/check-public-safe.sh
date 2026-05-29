#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

node <<'NODE'
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const ignoredDirs = new Set([".git", ".bridge", ".local", "node_modules"]);
const ignoredPrefixes = ["tmp_"];
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(root, path.join(dir, entry.name));
    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name) || ignoredPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
        continue;
      }
      walk(path.join(dir, entry.name));
      continue;
    }
    if (entry.isFile()) {
      scanFile(path.join(dir, entry.name), rel);
    }
  }
}

function addFinding(file, label, match) {
  findings.push({ file, label, match: String(match).slice(0, 160) });
}

function scanFile(file, rel) {
  const text = fs.readFileSync(file, "utf8");

  for (const match of text.matchAll(/sk-[A-Za-z0-9_-]{16,}/g)) {
    if (match[0] !== "sk-your-api-key-here") {
      addFinding(rel, "possible API key", match[0]);
    }
  }

  for (const match of text.matchAll(/\/Users\/[^/\s"']+/g)) {
    addFinding(rel, "local home path", match[0]);
  }

  for (const label of ["device_id", "account_uuid", "session_id"]) {
    const regexp = new RegExp(`"${label}"\\s*:\\s*"[^"]+"`, "g");
    for (const match of text.matchAll(regexp)) {
      addFinding(rel, `private ${label}`, match[0]);
    }
  }
}

walk(root);

if (findings.length) {
  console.error("Public safety scan failed:");
  for (const finding of findings) {
    console.error(`- ${finding.file}: ${finding.label}: ${finding.match}`);
  }
  process.exit(1);
}

console.log("Public safety scan passed.");
NODE
