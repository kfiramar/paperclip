#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseJson(text) {
  return JSON.parse(text);
}

const root = resolve(process.argv[2] ?? process.cwd());
const tempRoot = join(tmpdir(), `paperclip-e2e-smoke-${Date.now()}`);
const paperclipHome = join(tempRoot, "home");
const instanceId = "e2e";
const instanceRoot = join(paperclipHome, "instances", instanceId);
const serverLogPath = join(tempRoot, "server.log");

mkdirSync(join(instanceRoot, "secrets"), { recursive: true });
mkdirSync(join(tempRoot, "runtime", "secrets"), { recursive: true });

writeFileSync(
  join(instanceRoot, "config.json"),
  JSON.stringify(
    {
      $meta: {
        version: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
        source: "github-pr-sync-smoke",
      },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { deploymentMode: "local_trusted", host: "127.0.0.1", port: 3210 },
      auth: { baseUrlMode: "auto" },
      storage: { provider: "local_disk" },
      secrets: { provider: "local_encrypted", strictMode: false },
    },
    null,
    2,
  ),
);
writeFileSync(join(instanceRoot, ".env"), "PAPERCLIP_AGENT_JWT_SECRET=test-secret\n");
writeFileSync(join(tempRoot, "runtime", "secrets", "master.key"), "test-master-key-material");

const out = [];
const child = spawn("pnpm", ["--filter", "@paperclipai/server", "dev"], {
  cwd: root,
  env: {
    ...process.env,
    PAPERCLIP_HOME: paperclipHome,
    PAPERCLIP_INSTANCE_ID: instanceId,
  },
  detached: true,
});
child.stdout.on("data", (chunk) => {
  out.push(String(chunk));
  writeFileSync(serverLogPath, out.join(""));
});
child.stderr.on("data", (chunk) => {
  out.push(String(chunk));
  writeFileSync(serverLogPath, out.join(""));
});

async function shutdownChild() {
  if (child.exitCode == null && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((resolvePromise) => child.once("close", resolvePromise)),
      sleep(5000),
    ]);
  }
  if (child.exitCode == null && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    await Promise.race([
      new Promise((resolvePromise) => child.once("close", resolvePromise)),
      sleep(2000),
    ]);
  }
}

async function main() {
  let base = null;
  for (let i = 0; i < 120; i += 1) {
    const log = out.join("");
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+/);
    if (match) {
      base = match[0];
      try {
        const health = await fetch(`${base}/api/health`);
        if (health.ok) break;
      } catch {}
    }
    await sleep(1000);
  }

  if (!base) {
    fail(`Server did not become healthy.\n\nLogs:\n${out.join("")}`);
  }

  const post = async (url, body) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    return response.json();
  };

  const getJson = async (url) => {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    return response.json();
  };

  const company = await post(`${base}/api/companies`, { name: "E2E Sync Co" });
  const founder = await post(`${base}/api/companies/${company.id}/agents`, {
    name: "Founding Engineer",
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
  });
  const reviewer = await post(`${base}/api/companies/${company.id}/agents`, {
    name: "Code Reviewer",
    role: "engineer",
    adapterType: "process",
    adapterConfig: {},
  });
  const issue = await post(`${base}/api/companies/${company.id}/issues`, {
    title: "E2E PR sync",
    status: "todo",
    assigneeAgentId: founder.id,
  });

  const sync = await post(`${base}/api/issues/${issue.id}/github-pr-sync`, {
    repositoryFullName: "acme/supportopia",
    pullRequestNumber: 61,
    pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
    pullRequestTitle: "E2E sync PR",
    eventKey: "github:pr-61:review-1",
    eventKind: "review_requested",
    pullRequestStatus: "ready_for_review",
    summary: "Review requested from Code Reviewer.",
    stage: "review_requested",
    waitingOnRole: "Code Reviewer",
    nextAction: "Please review the PR.",
    labels: ["needs-review"],
    wakeAssignee: true,
    wakeAgentRefs: ["Code Reviewer"],
    syncComment: true,
  });

  const products = await getJson(`${base}/api/issues/${issue.id}/work-products`);
  const comments = await getJson(`${base}/api/issues/${issue.id}/comments`);
  if (!sync.ok) fail(`Sync failed: ${JSON.stringify(sync, null, 2)}`);
  if (!sync.wokenAgentIds.includes(reviewer.id)) fail(`Reviewer not woken: ${JSON.stringify(sync, null, 2)}`);
  if (!products.some((product) => product.type === "pull_request" && product.externalId === "61")) {
    fail(`Pull request work product missing: ${JSON.stringify(products, null, 2)}`);
  }
  if (!comments.some((comment) => comment.body.includes("STATE: review_requested"))) {
    fail(`Sync comment missing: ${JSON.stringify(comments, null, 2)}`);
  }

  const webhookPayload = {
    action: "ready_for_review",
    repository: { full_name: "acme/supportopia" },
    pull_request: {
      number: 62,
      html_url: "https://github.com/acme/supportopia/pull/62",
      title: "Webhook bridge sync",
      body: `Paperclip-Issue: ${issue.id}\n\nPlease review this PR.`,
      draft: false,
      labels: [],
    },
  };
  const webhookPath = join(tempRoot, "github-pull-request.json");
  writeFileSync(webhookPath, JSON.stringify(webhookPayload, null, 2));

  const bridge = spawn("node", [join(root, "scripts", "github-pr-webhook-bridge.mjs"), "pull_request", webhookPath], {
    cwd: root,
    env: {
      ...process.env,
      PAPERCLIP_API_URL: `${base}/api`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bridgeOut = [];
  const bridgeErr = [];
  bridge.stdout.on("data", (chunk) => bridgeOut.push(String(chunk)));
  bridge.stderr.on("data", (chunk) => bridgeErr.push(String(chunk)));
  const bridgeExit = await new Promise((resolvePromise) => bridge.on("close", resolvePromise));
  if (bridgeExit !== 0) {
    fail(`Webhook bridge failed.\nSTDOUT:\n${bridgeOut.join("")}\nSTDERR:\n${bridgeErr.join("")}`);
  }

  const bridgeProducts = await getJson(`${base}/api/issues/${issue.id}/work-products`);
  if (!bridgeProducts.some((product) => product.type === "pull_request" && product.externalId === "62")) {
    fail(`Bridge-created work product missing: ${JSON.stringify(bridgeProducts, null, 2)}`);
  }

  console.log(
    JSON.stringify(
      {
        base,
        sync,
        workProductCount: products.length,
        commentCount: comments.length,
        bridgeWorkProductCount: bridgeProducts.length,
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} catch (error) {
  await shutdownChild();
  rmSync(tempRoot, { recursive: true, force: true });
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}

await shutdownChild();
rmSync(tempRoot, { recursive: true, force: true });
