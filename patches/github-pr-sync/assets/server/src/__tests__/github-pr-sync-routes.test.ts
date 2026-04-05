import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubPrSyncRoutes } from "../routes/github-pr-sync.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  addComment: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(),
  link: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  resolveByReference: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
  createForIssue: vi.fn(),
  update: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSyncIssue = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
  approvalService: () => mockApprovalService,
  issueApprovalService: () => mockIssueApprovalService,
  agentService: () => mockAgentService,
  heartbeatService: () => mockHeartbeatService,
  workProductService: () => mockWorkProductService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/github-pr-sync.js", () => ({
  createGithubPrSyncService: () => ({
    syncIssue: mockSyncIssue,
  }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", githubPrSyncRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function createAgentApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId: "agent-1",
      companyId: "company-1",
      source: "agent_key",
    };
    next();
  });
  app.use("/api", githubPrSyncRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("githubPrSyncRoutes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 when the issue does not exist", async () => {
    mockIssueService.getById.mockReset().mockResolvedValue(null);

    const res = await request(createApp())
      .post("/api/issues/issue-1/github-pr-sync")
      .send({
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "comment_created",
        summary: "Comment added",
      });

    expect(res.status).toBe(404);
    expect(mockSyncIssue).not.toHaveBeenCalled();
  });

  it("accepts a normalized PR sync payload and logs the sync", async () => {
    mockIssueService.getById.mockReset().mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: "agent-1",
      title: "Implement PR sync",
    });
    mockSyncIssue.mockReset().mockResolvedValue({
      workProduct: { id: "wp-1" },
      approvalCreated: true,
      approvalId: "approval-1",
      wokenAgentIds: ["agent-1"],
    });
    mockLogActivity.mockResolvedValue(undefined);

    const res = await request(createApp())
      .post("/api/issues/issue-1/github-pr-sync")
      .send({
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        pullRequestNumber: 61,
        eventKind: "review_requested",
        summary: "Review requested from Code Reviewer.",
        waitingOnRole: "Code Reviewer",
      });

    expect(res.status).toBe(202);
    expect(mockSyncIssue).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        pullRequestNumber: 61,
        waitingOnRole: "Code Reviewer",
      }),
      expect.objectContaining({
        actorType: "user",
        actorId: "user-1",
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.github_pr_synced",
        entityId: "issue-1",
      }),
    );
  });

  it("rejects same-company agent keys because the bridge is board-operated", async () => {
    mockIssueService.getById.mockReset().mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      assigneeAgentId: "agent-1",
      title: "Implement PR sync",
    });

    const res = await request(createAgentApp())
      .post("/api/issues/issue-1/github-pr-sync")
      .send({
        pullRequestUrl: "https://github.com/acme/supportopia/pull/61",
        eventKind: "comment_created",
        summary: "Agent tried to sync PR comments directly.",
      });

    expect(res.status).toBe(403);
    expect(mockSyncIssue).not.toHaveBeenCalled();
  });
});
