import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubPrSyncService } from "../services/github-pr-sync.js";

function makeIssue() {
  return {
    id: "issue-1",
    companyId: "company-1",
    assigneeAgentId: "agent-assignee",
    title: "Implement PR sync",
    identifier: "SUP-99",
  };
}

function makeWorkProduct(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-04-05T00:00:00.000Z");
  return {
    id: "wp-1",
    companyId: "company-1",
    projectId: null,
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: "61",
    title: "PR 61",
    url: "https://github.com/acme/supportopia/pull/61",
    status: "active",
    reviewState: "none",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDeps() {
  return {
    issues: {
      getById: vi.fn(),
      addComment: vi.fn(),
    },
    workProducts: {
      listForIssue: vi.fn(),
      createForIssue: vi.fn(),
      update: vi.fn(),
    },
    approvals: {
      create: vi.fn(),
      cancel: vi.fn(),
    },
    issueApprovals: {
      listApprovalsForIssue: vi.fn(),
      link: vi.fn(),
    },
    agents: {
      resolveByReference: vi.fn(),
    },
    heartbeat: {
      wakeup: vi.fn(),
    },
  };
}

describe("createGithubPrSyncService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a PR work product, sync comment, approval, and wakeups for the assignee and waiting role", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([]);
    deps.workProducts.createForIssue.mockResolvedValue(makeWorkProduct());
    deps.issueApprovals.listApprovalsForIssue.mockResolvedValue([]);
    deps.approvals.create.mockResolvedValue({ id: "approval-1" });
    deps.approvals.cancel.mockResolvedValue({ approval: { id: "approval-1", status: "cancelled" }, applied: true });
    deps.issueApprovals.link.mockResolvedValue({ id: "link-1" });
    deps.issues.addComment.mockResolvedValue({ id: "comment-1" });
    deps.agents.resolveByReference.mockResolvedValue({ agent: { id: "agent-reviewer", name: "Code Reviewer" }, ambiguous: false });
    deps.heartbeat.wakeup.mockResolvedValue({ id: "wake-1" });

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        repositoryFullName: "acme/supportopia",
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        pullRequestTitle: "Add onboarding progress UI",
        eventKind: "review_submitted",
        pullRequestStatus: "changes_requested",
        reviewState: "changes_requested",
        summary: "Reviewer requested two fixes before QA.",
        stage: "implementation",
        waitingOnRole: "Code Reviewer",
        nextAction: "Address feedback and request re-review.",
        needsFounderApproval: true,
        createApproval: true,
        wakeAssignee: true,
        wakeAgentRefs: [],
        syncComment: true,
        labels: ["needs-review", "founder-approval-required"],
      },
      {
        actorType: "agent",
        actorId: "agent-founder",
        agentId: "agent-founder",
        runId: "run-1",
      },
    );

    expect(deps.workProducts.createForIssue).toHaveBeenCalledTimes(1);
    expect(deps.approvals.create).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        type: "approve_pull_request_merge",
        requestedByAgentId: "agent-founder",
      }),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("STATE: implementation"),
      expect.any(Object),
    );
    expect(deps.issues.addComment).toHaveBeenCalledWith(
      "issue-1",
      expect.stringContaining("WAITING ON: Code Reviewer"),
      expect.any(Object),
    );
    expect(deps.heartbeat.wakeup).toHaveBeenCalledTimes(2);
    expect(result.approvalCreated).toBe(true);
    expect(result.wokenAgentIds).toEqual(["agent-assignee", "agent-reviewer"]);
  });

  it("updates an existing PR work product and skips duplicate approvals/comments when disabled", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([makeWorkProduct()]);
    deps.workProducts.update.mockResolvedValue(makeWorkProduct({ status: "approved", reviewState: "approved" }));
    deps.issueApprovals.listApprovalsForIssue.mockResolvedValue([
      { id: "approval-1", type: "approve_pull_request_merge", status: "pending" },
    ]);
    deps.approvals.cancel.mockResolvedValue({ approval: { id: "approval-1", status: "cancelled" }, applied: true });

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "merged",
        summary: "Merged to main.",
        pullRequestStatus: "merged",
        reviewState: "approved",
        wakeAssignee: false,
        wakeAgentRefs: [],
        syncComment: false,
        createApproval: true,
        labels: [],
      },
      {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
    );

    expect(deps.workProducts.update).toHaveBeenCalledTimes(1);
    expect(deps.approvals.create).not.toHaveBeenCalled();
    expect(deps.approvals.cancel).toHaveBeenCalledWith(
      "approval-1",
      "board-user",
      "Automatically cancelled after pull request merged",
    );
    expect(deps.issues.addComment).not.toHaveBeenCalled();
    expect(deps.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(result.approvalCreated).toBe(false);
    expect(result.approvalId).toBe("approval-1");
    expect(result.approvalCancelledId).toBe("approval-1");
    expect(result.workProduct.status).toBe("approved");
  });

  it("creates a fresh merge approval after a previously rejected one", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([makeWorkProduct()]);
    deps.workProducts.update.mockResolvedValue(makeWorkProduct({ status: "ready_for_review" }));
    deps.issueApprovals.listApprovalsForIssue.mockResolvedValue([
      { id: "approval-old", type: "approve_pull_request_merge", status: "rejected" },
    ]);
    deps.approvals.create.mockResolvedValue({ id: "approval-new" });
    deps.approvals.cancel.mockResolvedValue({ approval: { id: "approval-old", status: "cancelled" }, applied: true });
    deps.issueApprovals.link.mockResolvedValue({ id: "link-2" });

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "merge_ready",
        summary: "A new heavy PR is ready for founder approval.",
        needsFounderApproval: true,
        createApproval: true,
        wakeAssignee: false,
        wakeAgentRefs: [],
        syncComment: false,
        labels: ["founder-approval-required"],
      },
      {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
    );

    expect(deps.approvals.create).toHaveBeenCalledTimes(1);
    expect(result.approvalCreated).toBe(true);
    expect(result.approvalId).toBe("approval-new");
  });

  it("treats matching eventKey replays as idempotent and skips comments and wakeups", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([
      makeWorkProduct({
        metadata: {
          lastAppliedEventKey: "github:pr-61:review-123",
        },
      }),
    ]);

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKey: "github:pr-61:review-123",
        eventKind: "review_submitted",
        summary: "Replay of the same review event.",
        wakeAssignee: true,
        wakeAgentRefs: ["Code Reviewer"],
        syncComment: true,
        labels: [],
      },
      {
        actorType: "agent",
        actorId: "agent-founder",
        agentId: "agent-founder",
      },
    );

    expect(result.idempotentReplay).toBe(true);
    expect(deps.issues.addComment).not.toHaveBeenCalled();
    expect(deps.heartbeat.wakeup).not.toHaveBeenCalled();
    expect(deps.approvals.create).not.toHaveBeenCalled();
  });

  it("preserves existing review state on non-state comment events", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([
      makeWorkProduct({
        status: "changes_requested",
        reviewState: "changes_requested",
      }),
    ]);
    deps.workProducts.update.mockResolvedValue(
      makeWorkProduct({
        status: "changes_requested",
        reviewState: "changes_requested",
      }),
    );

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "comment_created",
        summary: "Reviewer left a follow-up comment.",
        wakeAssignee: false,
        wakeAgentRefs: [],
        syncComment: false,
        labels: [],
      },
      {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
    );

    expect(result.workProduct.status).toBe("changes_requested");
    expect(result.workProduct.reviewState).toBe("changes_requested");
  });

  it("does not create a new approval on merged terminal events", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([makeWorkProduct()]);
    deps.workProducts.update.mockResolvedValue(makeWorkProduct({ status: "merged", reviewState: "approved" }));
    deps.issueApprovals.listApprovalsForIssue.mockResolvedValue([]);

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 61,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "merged",
        summary: "Pull request merged.",
        pullRequestStatus: "merged",
        needsFounderApproval: true,
        createApproval: true,
        wakeAssignee: false,
        wakeAgentRefs: [],
        syncComment: false,
        labels: ["founder-approval-required"],
      },
      {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
    );

    expect(deps.approvals.create).not.toHaveBeenCalled();
    expect(result.approvalCreated).toBe(false);
    expect(result.approvalId).toBe(null);
  });

  it("creates a new PR work product instead of overwriting a different existing PR on the same issue", async () => {
    const deps = createDeps();
    deps.issues.getById.mockResolvedValue(makeIssue());
    deps.workProducts.listForIssue.mockResolvedValue([
      makeWorkProduct({
        externalId: "61",
        url: "https://github.com/acme/supportopia/pull/61",
      }),
      makeWorkProduct({
        id: "wp-2",
        externalId: "62",
        url: "https://github.com/acme/supportopia/pull/62",
        title: "PR 62",
      }),
    ]);
    deps.workProducts.createForIssue.mockResolvedValue(
      makeWorkProduct({
        id: "wp-3",
        externalId: "63",
        url: "https://github.com/acme/supportopia/pull/63",
        title: "PR 63",
      }),
    );

    const svc = createGithubPrSyncService(deps as any);
    const result = await svc.syncIssue(
      "issue-1",
      {
        pullRequestNumber: 63,
        pullRequestUrl: "https://github.com/acme/supportopia/pull/63",
        eventKind: "opened",
        summary: "A third PR was opened for the issue.",
        wakeAssignee: false,
        wakeAgentRefs: [],
        syncComment: false,
        labels: [],
      },
      {
        actorType: "user",
        actorId: "board-user",
        userId: "board-user",
      },
    );

    expect(deps.workProducts.update).not.toHaveBeenCalled();
    expect(deps.workProducts.createForIssue).toHaveBeenCalledTimes(1);
    expect(result.workProduct.id).toBe("wp-3");
  });

});
