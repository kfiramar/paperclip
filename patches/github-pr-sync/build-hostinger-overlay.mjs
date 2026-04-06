#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLE_DIR = resolve(SCRIPT_DIR);
const TEMPLATE_DOCKERFILE = resolve(BUNDLE_DIR, "Dockerfile.hostinger-overlay");

function run(cmd, args, cwd, env = process.env) {
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
}

function usage() {
  console.error(
    "usage: node patches/github-pr-sync/build-hostinger-overlay.mjs <clean-paperclip-checkout> [--out-dir <dir>] [--image <tag>] [--skip-docker-build]",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) usage();

const targetCheckout = resolve(args[0]);
let outDir = null;
let imageTag = "paperclipai-patched:github-pr-sync-overlay";
let skipDockerBuild = false;

for (let i = 1; i < args.length; i += 1) {
  if (args[i] === "--out-dir") {
    outDir = resolve(args[++i]);
  } else if (args[i] === "--image") {
    imageTag = args[++i];
  } else if (args[i] === "--skip-docker-build") {
    skipDockerBuild = true;
  } else {
    usage();
  }
}

if (!existsSync(targetCheckout)) {
  throw new Error(`Target checkout does not exist: ${targetCheckout}`);
}
if (!existsSync(TEMPLATE_DOCKERFILE)) {
  throw new Error(`Missing Dockerfile template: ${TEMPLATE_DOCKERFILE}`);
}

// Apply + build in-place on the provided clean checkout.
run("node", [resolve(BUNDLE_DIR, "apply.mjs"), targetCheckout], BUNDLE_DIR);
run("pnpm", ["install", "--frozen-lockfile"], targetCheckout);
run("pnpm", ["build"], targetCheckout);

const contextDir =
  outDir ?? mkdtempSync(join(tmpdir(), "paperclip-hostinger-overlay-"));
mkdirSync(join(contextDir, "overlay", "cli", "dist"), { recursive: true });
mkdirSync(join(contextDir, "overlay", "server", "dist", "routes"), { recursive: true });
mkdirSync(join(contextDir, "overlay", "server", "dist", "services"), { recursive: true });
mkdirSync(join(contextDir, "overlay", "shared", "dist", "validators"), { recursive: true });
mkdirSync(join(contextDir, "overlay", "scripts"), { recursive: true });

const copies = [
  ["cli/dist/index.js", "overlay/cli/dist/index.js"],
  ["server/dist/app.js", "overlay/server/dist/app.js"],
  ["server/dist/routes/github-pr-sync.js", "overlay/server/dist/routes/github-pr-sync.js"],
  ["server/dist/services/github-pr-sync.js", "overlay/server/dist/services/github-pr-sync.js"],
  ["server/dist/services/approvals.js", "overlay/server/dist/services/approvals.js"],
  ["packages/shared/dist/constants.js", "overlay/shared/dist/constants.js"],
  ["packages/shared/dist/index.js", "overlay/shared/dist/index.js"],
  ["packages/shared/dist/validators/index.js", "overlay/shared/dist/validators/index.js"],
  ["packages/shared/dist/validators/github-pr-sync.js", "overlay/shared/dist/validators/github-pr-sync.js"],
  ["scripts/github-pr-sync.mjs", "overlay/scripts/github-pr-sync.mjs"],
  ["scripts/github-pr-webhook-bridge.mjs", "overlay/scripts/github-pr-webhook-bridge.mjs"],
];

for (const [srcRel, dstRel] of copies) {
  const src = resolve(targetCheckout, srcRel);
  const dst = resolve(contextDir, dstRel);
  if (!existsSync(src)) {
    throw new Error(`Expected build artifact missing: ${src}`);
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
}

writeFileSync(resolve(contextDir, "Dockerfile"), readFileSync(TEMPLATE_DOCKERFILE));

if (!skipDockerBuild) {
  run("docker", ["build", "-t", imageTag, contextDir], contextDir);
}

console.log(
  JSON.stringify(
    {
      contextDir,
      imageTag,
      dockerBuilt: !skipDockerBuild,
    },
    null,
    2,
  ),
);
