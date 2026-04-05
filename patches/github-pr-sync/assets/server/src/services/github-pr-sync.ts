import { conflict, notFound } from "../errors.js";
import type { GithubPullRequestSyncInput, IssueWorkProduct } from "@paperclipai/shared";

type ActorInfo = {
  actorType: "user" | "agent" | "system";
  actorId: string;
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

type IssueRecord = {
  id: string;
  companyId: string;
  assigneeAgentId: string | null;
  title: string;
  identifier?: string | null;
};

type ApprovalSummary = {
  id: string;
  type: string;
  status: string;
};

type AgentSummary = {
  id: string;
  name: string;
};

type WakeRun = { id?: string | null } | null;

interface GithubPrSyncDeps {
  issues: {
    getById(issueId: string): Promise<IssueRecord | null>;
    addComment(
      issueId: string,
      body: string,
      actor: { agentId?: string | null; userId?: string | null; runId?: string | null },
    ): Promise<{ id: string } | null>;
  };
  workProducts: {
    listForIssue(issueId: string): Promise<IssueWorkProduct[]>;
    createForIssue(
      issueId: string,
      companyId: string,
      data: Omit<IssueWorkProduct, "id" | "companyId" | "issueId" | "createdAt" | "updatedAt">,
    ): Promise<IssueWorkProduct | null>;
    update(
      id: string,
      patch: Partial<Omit<IssueWorkProduct, "id" | "companyId" | "issueId" | "createdAt" | "updatedAt">>,
    ): Promise<IssueWorkProduct | null>;
  };
  approvals: {
    create(
      companyId: string,
      data: {
        type: string;
        requestedByAgentId: string | null;
        requestedByUserId: string | null;
        status: string;
        payload: Record<string, unknown>;
        decisionNote: null;
        decidedByUserId: null;
        decidedAt: null;
        updatedAt: Date;
      },
    ): Promise<{ id: string }>;
    cancel(
      id: string,
      decidedByUserId: string,
      decisionNote?: string | null,
    ): Promise<{ approval: { id: string; status: string }; applied: boolean }>;
  };
  issueApprovals: {
    listApprovalsForIssue(issueId: string): Promise<ApprovalSummary[]>;
    link(issueId: string, approvalId: string, actor?: { agentId?: string | null; userId?: string | null }): Promise<unknown>;
  };
  agents: {
    resolveByReference(
      companyId: string,
      reference: string,
    ): Promise<{ agent: AgentSummary | null; ambiguous: boolean }>;
  };
  heartbeat: {
    wakeup(agentId: string, input: Record<string, unknown>): Promise<WakeRun>;
  };
}

type SyncResult = {
  workProduct: IssueWorkProduct;
  approvalCreated: boolean;
  approvalId: string | null;
  approvalCancelledId: string | null;
  idempotentReplay: boolean;
  wokenAgentIds: string[];
};

function normalizeWhitespace(value: string | null | undefined) {
  return value?.trim() || null;
}

function deriveWorkProductStatus(input: GithubPullRequestSyncInput, existingPr: IssueWorkProduct | null): string {
  if (input.pullRequestStatus) return input.pullRequestStatus;
  if (input.eventKind === "merged") return "merged";
  if (input.eventKind === "closed") return "closed";
  if (input.eventKind === "ready_for_review" || input.eventKind === "review_requested") return "ready_for_review";
  if (input.eventKind === "review_submitted" && input.reviewState === "changes_requested") return "changes_requested";
  if (input.eventKind === "review_submitted" && input.reviewState === "approved") return "approved";
  return existingPr?.status ?? "active";
}

function deriveReviewState(input: GithubPullRequestSyncInput, existingPr: IssueWorkProduct | null): IssueWorkProduct["reviewState"] {
  if (input.reviewState) return input.reviewState;
  if (input.needsFounderApproval) return "needs_board_review";
  return existingPr?.reviewState ?? "none";
}

function isTerminalPrEvent(input: GithubPullRequestSyncInput) {
  return input.eventKind === "merged" || input.eventKind === "closed";
}

function findMatchingPrWorkProduct(existingProducts: IssueWorkProduct[], input: GithubPullRequestSyncInput) {
  const githubPrProducts = existingProducts.filter(
    (product) => product.type === "pull_request" && product.provider === "github",
  );

  const exactByNumber =
    input.pullRequestNumber != null
      ? githubPrProducts.find((product) => product.externalId === String(input.pullRequestNumber)) ?? null
      : null;
  if (exactByNumber) return exactByNumber;

  const exactByUrl = githubPrProducts.find((product) => product.url === input.pullRequestUrl) ?? null;
  if (exactByUrl) return exactByUrl;

  if (githubPrProducts.length === 1 && input.pullRequestNumber == null && !input.repositoryFullName) {
    return githubPrProducts[0] ?? null;
  }

  return null;
}

function buildSyncComment(input: GithubPullRequestSyncInput) {
  const lines = [
    `STATE: ${input.stage ?? input.eventKind}`,
    `LINK: ${input.pullRequestUrl}`,
    `SUMMARY: ${input.summary}`,
  ];
  if (input.waitingOnRole) lines.push(`WAITING ON: ${input.waitingOnRole}`);
  if (input.documentationStatus) lines.push(`DOCS: ${input.documentationStatus}`);
  if (input.qaVerdict) lines.push(`QA: ${input.qaVerdict}`);
  if (input.nextAction) lines.push(`NEXT: ${input.nextAction}`);
  if (input.details) lines.push("", input.details);
  return lines.join("\n");
}

function shouldCreatePrMergeApproval(existingApprovals: ApprovalSummary[]) {
  return !existingApprovals.some(
    (approval) =>
      approval.type === "approve_pull_request_merge"
      && !["rejected", "cancelled"].includes(approval.status),
  );
}

function toActorCommentContext(actor: ActorInfo) {
  return {
    agentId: actor.agentId ?? null,
    userId: actor.userId ?? (actor.actorType === "user" ? actor.actorId : null),
    runId: actor.runId ?? null,
  };
}

function toWakeContext(input: GithubPullRequestSyncInput, issueId: string) {
  return {
    source: "automation",
    triggerDetail: "system",
    reason: "github_pull_request_sync",
    payload: {
      issueId,
      pullRequestUrl: input.pullRequestUrl,
      pullRequestNumber: input.pullRequestNumber ?? null,
      eventKind: input.eventKind,
      commentUrl: input.commentUrl ?? null,
      stage: input.stage ?? null,
      waitingOnRole: input.waitingOnRole ?? null,
    },
    requestedByActorType: "system",
    requestedByActorId: "github_pr_sync",
    contextSnapshot: {
      issueId,
      taskId: issueId,
      source: "github.pull_request.sync",
      wakeReason: "github_pull_request_sync",
      pullRequestUrl: input.pullRequestUrl,
      pullRequestNumber: input.pullRequestNumber ?? null,
      eventKind: input.eventKind,
      stage: input.stage ?? null,
      waitingOnRole: input.waitingOnRole ?? null,
      commentUrl: input.commentUrl ?? null,
      actorLogin: input.actorLogin ?? null,
    },
  };
}

async function resolveWakeAgentIds(
  deps: GithubPrSyncDeps,
  issue: IssueRecord,
  input: GithubPullRequestSyncInput,
) {
  const ids = new Set<string>();
  if (input.wakeAssignee && issue.assigneeAgentId) ids.add(issue.assigneeAgentId);
  const refs = [...input.wakeAgentRefs];
  if (input.waitingOnRole) refs.push(input.waitingOnRole);
  for (const ref of refs) {
    const resolved = await deps.agents.resolveByReference(issue.companyId, ref);
    if (resolved.ambiguous) {
      throw conflict(`Ambiguous agent reference '${ref}' in GitHub PR sync wake targets`);
    }
    if (resolved.agent) ids.add(resolved.agent.id);
  }
  return [...ids];
}

export function createGithubPrSyncService(deps: GithubPrSyncDeps) {
  return {
    async syncIssue(issueId: string, input: GithubPullRequestSyncInput, actor: ActorInfo): Promise<SyncResult> {
      const issue = await deps.issues.getById(issueId);
      if (!issue) throw notFound("Issue not found");

      const existingProducts = await deps.workProducts.listForIssue(issue.id);
      const existingPr = findMatchingPrWorkProduct(existingProducts, input);
      const existingMetadata = (existingPr?.metadata ?? {}) as Record<string, unknown>;
      const priorEventKey =
        typeof existingMetadata.lastAppliedEventKey === "string" ? existingMetadata.lastAppliedEventKey : null;

      if (input.eventKey && priorEventKey === input.eventKey && existingPr) {
        return {
          workProduct: existingPr,
          approvalCreated: false,
          approvalId: null,
          approvalCancelledId: null,
          idempotentReplay: true,
          wokenAgentIds: [],
        };
      }

      const metadata = {
        ...existingMetadata,
        repositoryFullName: normalizeWhitespace(input.repositoryFullName),
        pullRequestNumber: input.pullRequestNumber ?? null,
        pullRequestUrl: input.pullRequestUrl,
        pullRequestTitle: normalizeWhitespace(input.pullRequestTitle),
        pullRequestBody: normalizeWhitespace(input.pullRequestBody),
        eventKind: input.eventKind,
        actorLogin: normalizeWhitespace(input.actorLogin),
        commentUrl: normalizeWhitespace(input.commentUrl),
        stage: normalizeWhitespace(input.stage),
        waitingOnRole: normalizeWhitespace(input.waitingOnRole),
        documentationStatus: normalizeWhitespace(input.documentationStatus),
        qaVerdict: normalizeWhitespace(input.qaVerdict),
        labels: input.labels,
        needsFounderApproval: input.needsFounderApproval,
        lastSyncedAt: input.eventAt ?? new Date().toISOString(),
      };

      const patch = {
        externalId: input.pullRequestNumber != null ? String(input.pullRequestNumber) : existingPr?.externalId ?? null,
        title: normalizeWhitespace(input.pullRequestTitle) ?? existingPr?.title ?? `PR ${input.pullRequestNumber ?? ""}`.trim(),
        url: input.pullRequestUrl,
        status: deriveWorkProductStatus(input, existingPr),
        reviewState: deriveReviewState(input, existingPr),
        isPrimary: true,
        summary: input.summary,
        metadata,
      } satisfies Partial<Omit<IssueWorkProduct, "id" | "companyId" | "issueId" | "createdAt" | "updatedAt">>;

      const workProduct = existingPr
        ? await deps.workProducts.update(existingPr.id, patch)
        : await deps.workProducts.createForIssue(issue.id, issue.companyId, {
            projectId: null,
            executionWorkspaceId: null,
            runtimeServiceId: null,
            type: "pull_request",
            provider: "github",
            externalId: patch.externalId ?? null,
            title: patch.title ?? `PR ${input.pullRequestNumber ?? ""}`.trim(),
            url: patch.url ?? null,
            status: patch.status ?? "active",
            reviewState: patch.reviewState ?? "none",
            isPrimary: true,
            healthStatus: "unknown",
            summary: patch.summary ?? null,
            metadata: patch.metadata ?? null,
            createdByRunId: actor.runId ?? null,
          });

      if (!workProduct) {
        throw conflict("Failed to persist GitHub pull request work product");
      }

      let approvalId: string | null = null;
      let approvalCreated = false;
      let approvalCancelledId: string | null = null;
      const existingApprovals = await deps.issueApprovals.listApprovalsForIssue(issue.id);
      if (!isTerminalPrEvent(input) && (input.createApproval || input.needsFounderApproval)) {
        const existingApproval =
          existingApprovals.find(
            (approval) =>
              approval.type === "approve_pull_request_merge"
              && !["rejected", "cancelled"].includes(approval.status),
          )
          ?? null;
        if (existingApproval) {
          approvalId = existingApproval.id;
        }
        if (shouldCreatePrMergeApproval(existingApprovals)) {
          const approval = await deps.approvals.create(issue.companyId, {
            type: "approve_pull_request_merge",
            requestedByAgentId: actor.agentId ?? null,
            requestedByUserId: actor.userId ?? (actor.actorType === "user" ? actor.actorId : null),
            status: "pending",
            payload: {
              issueId: issue.id,
              issueIdentifier: issue.identifier ?? null,
              issueTitle: issue.title,
              provider: "github",
              pullRequestUrl: input.pullRequestUrl,
              pullRequestNumber: input.pullRequestNumber ?? null,
              repositoryFullName: input.repositoryFullName ?? null,
              summary: input.summary,
              stage: input.stage ?? null,
              waitingOnRole: input.waitingOnRole ?? null,
              documentationStatus: input.documentationStatus ?? null,
              qaVerdict: input.qaVerdict ?? null,
              labels: input.labels,
              reason: input.needsFounderApproval ? "founder_approval_required" : "manual_request",
            },
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
            updatedAt: new Date(),
          });
          await deps.issueApprovals.link(issue.id, approval.id, {
            agentId: actor.agentId ?? null,
            userId: actor.userId ?? (actor.actorType === "user" ? actor.actorId : null),
          });
          approvalId = approval.id;
          approvalCreated = true;
        }
      }
      if (isTerminalPrEvent(input)) {
        const activeApproval =
          existingApprovals.find(
            (approval) =>
              approval.type === "approve_pull_request_merge"
              && ["pending", "revision_requested"].includes(approval.status),
          )
          ?? null;
        if (activeApproval) {
          await deps.approvals.cancel(
            activeApproval.id,
            actor.userId ?? actor.actorId,
            `Automatically cancelled after pull request ${input.eventKind}`,
          );
          approvalCancelledId = activeApproval.id;
          if (!approvalId) approvalId = activeApproval.id;
        }
      }

      if (input.syncComment) {
        await deps.issues.addComment(issue.id, buildSyncComment(input), toActorCommentContext(actor));
      }

      const wakeAgentIds = await resolveWakeAgentIds(deps, issue, input);
      for (const agentId of wakeAgentIds) {
        await deps.heartbeat.wakeup(agentId, toWakeContext(input, issue.id));
      }

      if (input.eventKey) {
        const appliedMetadata = {
          ...((workProduct.metadata ?? {}) as Record<string, unknown>),
          lastAppliedEventKey: input.eventKey,
          lastAppliedAt: input.eventAt ?? new Date().toISOString(),
        };
        const updated = await deps.workProducts.update(workProduct.id, {
          metadata: appliedMetadata,
        });
        if (updated) {
          return {
            workProduct: updated,
            approvalCreated,
            approvalId,
            approvalCancelledId,
            idempotentReplay: false,
            wokenAgentIds: wakeAgentIds,
          };
        }
      }

      return {
        workProduct,
        approvalCreated,
        approvalId,
        approvalCancelledId,
        idempotentReplay: false,
        wokenAgentIds: wakeAgentIds,
      };
    },
  };
}
