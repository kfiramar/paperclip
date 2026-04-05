import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { githubPullRequestSyncSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  approvalService,
  heartbeatService,
  issueApprovalService,
  issueService,
  logActivity,
  workProductService,
} from "../services/index.js";
import { createGithubPrSyncService } from "../services/github-pr-sync.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function githubPrSyncRoutes(db: Db) {
  const router = Router();
  const issues = issueService(db);
  const approvals = approvalService(db);
  const issueApprovals = issueApprovalService(db);
  const agents = agentService(db);
  const heartbeat = heartbeatService(db);
  const workProducts = workProductService(db);
  const syncService = createGithubPrSyncService({
    issues,
    approvals,
    issueApprovals,
    agents,
    heartbeat,
    workProducts,
  });

  router.post("/issues/:id/github-pr-sync", validate(githubPullRequestSyncSchema), async (req, res) => {
    assertBoard(req);
    const issueId = req.params.id as string;
    const issue = await issues.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    assertCompanyAccess(req, issue.companyId);
    const actor = getActorInfo(req);
    const input = req.body;
    const result = await syncService.syncIssue(issue.id, input, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      userId: actor.actorType === "user" ? actor.actorId : null,
      runId: actor.runId ?? null,
    });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.github_pr_synced",
      entityType: "issue",
      entityId: issue.id,
      details: {
        pullRequestUrl: input.pullRequestUrl,
        pullRequestNumber: input.pullRequestNumber ?? null,
        eventKind: input.eventKind,
        stage: input.stage ?? null,
        waitingOnRole: input.waitingOnRole ?? null,
        approvalCreated: result.approvalCreated,
        approvalId: result.approvalId,
        approvalCancelledId: result.approvalCancelledId,
        idempotentReplay: result.idempotentReplay,
        wokenAgentIds: result.wokenAgentIds,
      },
    });

    res.status(202).json({
      ok: true,
      issueId: issue.id,
      workProductId: result.workProduct.id,
      approvalCreated: result.approvalCreated,
      approvalId: result.approvalId,
      approvalCancelledId: result.approvalCancelledId,
      idempotentReplay: result.idempotentReplay,
      wokenAgentIds: result.wokenAgentIds,
    });
  });

  return router;
}
