---
title: GitHub PR Collaboration
summary: How to use GitHub pull request comments as the execution conversation surface while keeping Paperclip as the control plane
---

# GitHub PR Collaboration

Paperclip is the company control plane. GitHub PRs are the best place for code-level discussion once a pull request exists.

## Workflow rule

- **Before a PR exists**: discuss in the Paperclip issue
- **After a PR exists**: implementation, review, QA, and release discussion should happen on the GitHub PR
- **At every stage transition**: sync a short status summary back into the linked Paperclip issue

## Required PR documentation

### Engineer PR body or opening comment

Include:

- linked Paperclip issue
- problem being solved
- scope / non-goals
- tests run
- risks
- docs touched or `no-doc-impact`
- what feedback is desired now

### Reviewer summary

Include:

- verdict: `APPROVE`, `REQUEST_CHANGES`, or `BLOCKED`
- top issues
- merge conditions
- documentation impact

### QA summary

Include:

- environment used
- commands run
- manual / MCP / browser checks
- evidence links, screenshots, or logs
- verdict: `QA PASS` or `QA FAIL`
- known gaps

### Release summary

Include:

- reviewer verdict
- QA verdict
- docs status
- founder approval state if heavy
- recommendation: `MERGE` or `HOLD`

## Syncing GitHub PR state back into Paperclip

Paperclip exposes a normalized sync endpoint:

```http
POST /api/issues/:issueId/github-pr-sync
```

This endpoint is designed for a small bridge layer that receives GitHub webhook events or polling results, normalizes them, and sends them into Paperclip.

For a minimal bridge client, this repo now includes:

```bash
node scripts/github-pr-sync.mjs <issue-id> <payload.json>
```

For GitHub webhook-style payloads, this repo also includes:

```bash
node scripts/github-pr-webhook-bridge.mjs <event-name> <payload.json>
```

The webhook bridge expects the PR body to include:

```text
Paperclip-Issue: SUP-33
```

or a UUID issue id.

### Example payload

```json
{
  "repositoryFullName": "acme/supportopia",
  "pullRequestNumber": 61,
  "pullRequestUrl": "https://github.com/acme/supportopia/pull/61",
  "pullRequestTitle": "Add onboarding knowledge-base sync progress UI",
  "eventKey": "github:pr-61:review-12345",
  "eventKind": "review_submitted",
  "pullRequestStatus": "changes_requested",
  "reviewState": "changes_requested",
  "summary": "Reviewer requested two fixes before QA.",
  "stage": "implementation",
  "waitingOnRole": "Founding Engineer",
  "nextAction": "Address reviewer feedback and request re-review.",
  "documentationStatus": "no-doc-impact",
  "labels": ["needs-review"],
  "wakeAssignee": true,
  "wakeAgentRefs": ["Founding Engineer"],
  "syncComment": true
}
```

### What the sync endpoint does

When called successfully, Paperclip will:

1. upsert the linked GitHub pull request as an issue work product
2. update PR metadata such as stage, review state, QA verdict, labels, and last synced event
3. optionally add a concise sync-back comment to the issue
4. optionally wake the issue assignee and named agents
5. optionally create a pull-request-merge approval when founder review is required

If `eventKey` is provided and matches the last synced event for the same PR work product, Paperclip treats the call as an idempotent replay and skips duplicate comments and wakeups.

This endpoint is intended for **board-operated bridge automation**, not normal engineering-agent mutations.

## Heavy PR founder approval

Use founder approval only for high-blast-radius PRs.

Typical heavy PR triggers:

- auth, secrets, permissions, billing, budgets
- deployment or runtime configuration
- schema migrations or irreversible data changes
- public API contract changes
- broad cross-cutting architecture changes

When a sync payload sets `needsFounderApproval: true` or `createApproval: true`, Paperclip can create an `approve_pull_request_merge` approval linked to the issue.

When the PR later syncs as `merged` or `closed`, Paperclip cancels any still-pending merge approval for that issue.

## Suggested bridge pattern

Keep the bridge layer small.

Recommended flow:

1. GitHub event arrives
2. bridge maps PR -> Paperclip issue using `Paperclip-Issue: ...` in the PR body
3. bridge posts normalized payload to `/api/issues/:issueId/github-pr-sync`
4. Paperclip updates state, comments, approvals, and wakeups

This keeps GitHub as the execution conversation surface without turning Paperclip into a pull request UI clone.
