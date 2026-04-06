#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

const root = resolve(process.argv[2] ?? process.cwd());
run("pnpm", ["install", "--frozen-lockfile"], root);
run("pnpm", ["--filter", "@paperclipai/server", "exec", "vitest", "run", "src/__tests__/github-pr-sync-service.test.ts", "src/__tests__/github-pr-sync-routes.test.ts", "src/__tests__/approvals-service.test.ts"], root);
run("node", [resolve(SCRIPT_DIR, "smoke.mjs"), root], root);
