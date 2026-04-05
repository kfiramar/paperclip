import { z } from "zod";
import { issueWorkProductReviewStateSchema, issueWorkProductStatusSchema } from "./work-product.js";

export const githubPullRequestSyncEventKindSchema = z.enum([
  "opened",
  "ready_for_review",
  "review_requested",
  "review_submitted",
  "comment_created",
  "qa_requested",
  "qa_result",
  "release_requested",
  "merge_ready",
  "merged",
  "closed",
  "label_changed",
  "ci_failed",
  "ci_passed",
  "sync_note",
]);

export const githubPullRequestSyncSchema = z.object({
  repositoryFullName: z.string().trim().min(1).optional().nullable(),
  pullRequestNumber: z.number().int().positive().optional().nullable(),
  pullRequestUrl: z.string().url(),
  pullRequestTitle: z.string().trim().min(1).optional().nullable(),
  pullRequestBody: z.string().optional().nullable(),
  eventKey: z.string().trim().min(1).optional().nullable(),
  pullRequestStatus: issueWorkProductStatusSchema.optional(),
  reviewState: issueWorkProductReviewStateSchema.optional(),
  summary: z.string().trim().min(1),
  details: z.string().optional().nullable(),
  commentUrl: z.string().url().optional().nullable(),
  actorLogin: z.string().trim().min(1).optional().nullable(),
  eventKind: githubPullRequestSyncEventKindSchema,
  stage: z.string().trim().min(1).optional().nullable(),
  waitingOnRole: z.string().trim().min(1).optional().nullable(),
  nextAction: z.string().trim().min(1).optional().nullable(),
  documentationStatus: z.string().trim().min(1).optional().nullable(),
  qaVerdict: z.string().trim().min(1).optional().nullable(),
  labels: z.array(z.string().trim().min(1)).optional().default([]),
  needsFounderApproval: z.boolean().optional().default(false),
  createApproval: z.boolean().optional().default(false),
  wakeAssignee: z.boolean().optional().default(true),
  wakeAgentRefs: z.array(z.string().trim().min(1)).optional().default([]),
  syncComment: z.boolean().optional().default(true),
  eventAt: z.string().datetime().optional().nullable(),
});

export type GithubPullRequestSyncInput = z.infer<typeof githubPullRequestSyncSchema>;
