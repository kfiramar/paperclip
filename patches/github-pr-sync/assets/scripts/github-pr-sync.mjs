#!/usr/bin/env node
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

const [, , issueId, payloadFile] = process.argv;
if (!issueId || !payloadFile) {
  fail("usage: node scripts/github-pr-sync.mjs <issue-id> <payload-json-file>");
}

const baseUrl = process.env.PAPERCLIP_API_URL?.trim() || "http://127.0.0.1:3100/api";
const token = process.env.PAPERCLIP_API_TOKEN?.trim() || process.env.PAPERCLIP_BOARD_TOKEN?.trim() || "";

let payload;
try {
  payload = JSON.parse(readFileSync(payloadFile, "utf8"));
} catch (error) {
  fail(`failed to parse payload file ${payloadFile}: ${error instanceof Error ? error.message : String(error)}`);
}

const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};

const response = await fetch(`${baseUrl}/issues/${issueId}/github-pr-sync`, {
  method: "POST",
  headers,
  body: JSON.stringify(payload),
});

const text = await response.text();
if (!response.ok) {
  fail(`${response.status} ${text}`);
}

console.log(text);
