#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const host = process.argv[2] ?? "root@187.124.171.224";

execFileSync(resolve(SCRIPT_DIR, "supportopia-remote-pr-ops.sh"), [host], {
  stdio: "inherit",
});
