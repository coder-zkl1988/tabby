import { z } from "zod";

// --- Enums ---

export const sessionStatusSchema = z.enum(["active", "ended"]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionRunStateSchema = z.enum(["idle", "running", "failed"]);
export type SessionRunState = z.infer<typeof sessionRunStateSchema>;

export const sessionArchiveFilterSchema = z.enum([
  "exclude",
  "include",
  "only",
]);
export type SessionArchiveFilter = z.infer<typeof sessionArchiveFilterSchema>;

export const sessionKindSchema = z.enum(["conversations", "scheduled"]);
export type SessionKind = z.infer<typeof sessionKindSchema>;

// --- Input schemas ---

export const createSessionSchema = z.object({
  botId: z.string().min(1),
  sessionKey: z.string().min(1),
  title: z.string().min(1).max(500),
  channelType: z.string().optional(),
  channelId: z.string().optional(),
  status: sessionStatusSchema.optional(),
  messageCount: z.number().int().optional(),
  lastMessageAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateSessionInput = z.infer<typeof createSessionSchema>;

export const updateSessionSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: sessionStatusSchema.optional(),
  messageCount: z.number().int().optional(),
  lastMessageAt: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

export const sessionOrganizationPatchSchema = z.object({
  category: z.string().trim().min(1).max(80).optional(),
  clearCategory: z.boolean().optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
});
export type SessionOrganizationPatch = z.infer<
  typeof sessionOrganizationPatchSchema
>;

// --- Response schemas ---

export const sessionResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  sessionKey: z.string(),
  channelType: z.string().nullable(),
  channelId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  messageCount: z.number(),
  lastMessageAt: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  category: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
  archived: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
  checkpointCount: z.number().int().nonnegative().optional(),
  runState: sessionRunStateSchema.optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  totalTokensFresh: z.boolean().optional(),
  contextTokens: z.number().int().positive().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  modelProvider: z.string().optional(),
  model: z.string().optional(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionResponseSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});
export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionCheckpointReasonSchema = z.enum([
  "manual",
  "auto-threshold",
  "overflow-retry",
  "timeout-retry",
]);
export type SessionCheckpointReason = z.infer<
  typeof sessionCheckpointReasonSchema
>;

export const sessionCheckpointSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  reason: sessionCheckpointReasonSchema,
  tokensBefore: z.number().int().nonnegative().optional(),
  tokensAfter: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
});
export type SessionCheckpoint = z.infer<typeof sessionCheckpointSchema>;

export const sessionCheckpointListResponseSchema = z.object({
  checkpoints: z.array(sessionCheckpointSchema),
});

export const sessionRecoveryBranchResponseSchema = z.object({
  id: z.string(),
  botId: z.string(),
  sessionKey: z.string(),
  title: z.string(),
  checkpoint: sessionCheckpointSchema,
});

const sessionEditorFields = {
  editorText: z.string().optional(),
  editorAttachments: z
    .array(z.object({ mimeType: z.string(), data: z.string() }))
    .optional(),
};

export const sessionMessageBranchResponseSchema = z.object({
  ...sessionEditorFields,
  id: z.string(),
  botId: z.string(),
  sessionKey: z.string(),
  title: z.string(),
  messageId: z.string(),
});

export const sessionMessageRollbackResponseSchema = z.object({
  ...sessionEditorFields,
  ok: z.literal(true),
  id: z.string(),
  sessionKey: z.string(),
  messageId: z.string(),
});
