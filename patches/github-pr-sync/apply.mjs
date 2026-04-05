#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLE_ROOT = resolve(SCRIPT_DIR, "..", "..");
const MANIFEST_PATH = resolve(SCRIPT_DIR, "manifest.json");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function output(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const force = process.argv.includes("--force");

if (!existsSync(MANIFEST_PATH)) fail(`Manifest missing: ${MANIFEST_PATH}`);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

try {
  const inside = output("git", ["rev-parse", "--is-inside-work-tree"], repoRoot);
  if (inside !== "true") fail(`Not a git worktree: ${repoRoot}`);
} catch {
  fail(`Not a git worktree: ${repoRoot}`);
}

const status = output("git", ["status", "--porcelain"], repoRoot);
if (status.length > 0) {
  fail(`Repo must be clean before apply.\n\nCurrent status:\n${status}`);
}

for (const file of manifest.files) {
  const targetPath = resolve(repoRoot, file.target);
  const sourcePath = resolve(BUNDLE_ROOT, file.asset);
  if (!existsSync(sourcePath)) fail(`Asset missing: ${sourcePath}`);

  if (file.kind === "replace") {
    if (!existsSync(targetPath)) {
      fail(`Expected existing target missing: ${file.target}`);
    }
    if (!force && sha256(targetPath) !== file.baseSha256) {
      fail(`Base file hash mismatch for ${file.target}. Re-run with --force if intentional.`);
    }
  } else if (file.kind === "create" && existsSync(targetPath) && !force) {
    fail(`Target already exists for create entry: ${file.target}. Re-run with --force if intentional.`);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  copyFileSync(sourcePath, targetPath);
  if (file.executable) {
    chmodSync(targetPath, 0o755);
  }
}

console.log(`Applied GitHub PR sync bundle from ${MANIFEST_PATH} to ${repoRoot}`);
