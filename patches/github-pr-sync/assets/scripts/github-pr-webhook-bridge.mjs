#!/usr/bin/env node
import { readFileSync } from "node:fs";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  fail("usage: node scripts/github-pr-webhook-bridge.mjs <event-name> <payload-json-file>");
}

function linkedIssueReferenceFromBody(body) {
  if (!body) return null;
  const match = body.match(/Paperclip-Issue:\s*([^\s]+)/i);
  return match?.[1]?.trim() || null;
}

function toReviewState(state) {
  if (state === "approved") return "approved";
  if (state === "changes_requested") return "changes_requested";
  return undefined;
}

function normalize(eventName, payload, eventKey) {
  if (eventName === "pull_request") {
    const pr = payload.pull_request;
    if (!pr) fail("pull_request payload missing pull_request");
    const issueRef = linkedIssueReferenceFromBody(pr.body);
    if (!issueRef) fail("pull_request body missing 'Paperclip-Issue: <issue-id-or-identifier>'");
    const action = payload.action;
    const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label.name).filter(Boolean) : [];
    const isHeavy = labels.includes("founder-approval-required");
    let eventKind = "sync_note";
    if (action === "opened" || action === "reopened" || action === "synchronize") eventKind = "opened";
    else if (action === "ready_for_review") eventKind = "ready_for_review";
    else if (action === "review_requested") eventKind = "review_requested";
    else if (action === "closed" && pr.merged_at) eventKind = "merged";
    else if (action === "closed") eventKind = "closed";
    return {
      issueRef,
      syncPayload: {
        repositoryFullName: payload.repository?.full_name ?? null,
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.html_url,
        pullRequestTitle: pr.title ?? null,
        pullRequestBody: pr.body ?? null,
        pullRequestStatus:
          eventKind === "merged" ? "merged" : eventKind === "closed" ? "closed" : pr.draft ? "draft" : "ready_for_review",
        eventKey,
        eventKind,
        summary: `GitHub PR ${action}: ${pr.title}`,
        stage: eventKind,
        labels,
        needsFounderApproval: isHeavy,
        createApproval: isHeavy && !["merged", "closed"].includes(eventKind),
        syncComment: true,
      },
    };
  }

  if (eventName === "pull_request_review") {
    const pr = payload.pull_request;
    const review = payload.review;
    if (!pr || !review) fail("pull_request_review payload missing pull_request/review");
    const issueRef = linkedIssueReferenceFromBody(pr.body);
    if (!issueRef) fail("pull_request body missing 'Paperclip-Issue: <issue-id-or-identifier>'");
    return {
      issueRef,
      syncPayload: {
        repositoryFullName: payload.repository?.full_name ?? null,
        pullRequestNumber: pr.number,
        pullRequestUrl: pr.html_url,
        pullRequestTitle: pr.title ?? null,
        eventKey,
        eventKind: "review_submitted",
        summary: `GitHub review ${review.state}: ${pr.title}`,
        stage: "review_submitted",
        reviewState: toReviewState(review.state),
        commentUrl: review.html_url ?? null,
        actorLogin: review.user?.login ?? null,
        syncComment: true,
      },
    };
  }

  if (eventName === "issue_comment") {
    const issue = payload.issue;
    const pr = payload.issue?.pull_request;
    if (!issue || !pr) fail("issue_comment payload is not for a pull request");
    const body = issue.body ?? "";
    const issueRef = linkedIssueReferenceFromBody(body);
    if (!issueRef) fail("pull_request body missing 'Paperclip-Issue: <issue-id-or-identifier>'");
    return {
      issueRef,
      syncPayload: {
        repositoryFullName: payload.repository?.full_name ?? null,
        pullRequestNumber: issue.number,
        pullRequestUrl: issue.html_url,
        pullRequestTitle: issue.title ?? null,
        eventKey,
        eventKind: "comment_created",
        summary: `GitHub PR comment by ${payload.comment?.user?.login ?? "unknown"}`,
        stage: "comment_created",
        commentUrl: payload.comment?.html_url ?? null,
        actorLogin: payload.comment?.user?.login ?? null,
        details: payload.comment?.body ?? null,
        syncComment: true,
      },
    };
  }

  fail(`unsupported GitHub event '${eventName}'`);
}

const [, , eventName, payloadFile] = process.argv;
if (!eventName || !payloadFile) usage();

let payload;
try {
  payload = JSON.parse(readFileSync(payloadFile, "utf8"));
} catch (error) {
  fail(`failed to parse payload file ${payloadFile}: ${error instanceof Error ? error.message : String(error)}`);
}

const baseUrl = process.env.PAPERCLIP_API_URL?.trim() || "http://127.0.0.1:3100/api";
const token = process.env.PAPERCLIP_API_TOKEN?.trim() || process.env.PAPERCLIP_BOARD_TOKEN?.trim() || "";
const eventKey =
  process.env.GITHUB_EVENT_KEY?.trim()
  || process.env.GITHUB_DELIVERY?.trim()
  || `github:${eventName}:${Date.now()}`;

const { issueRef, syncPayload } = normalize(eventName, payload, eventKey);
const response = await fetch(`${baseUrl}/issues/${issueRef}/github-pr-sync`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(syncPayload),
});

const text = await response.text();
if (!response.ok) fail(`${response.status} ${text}`);
console.log(text);
