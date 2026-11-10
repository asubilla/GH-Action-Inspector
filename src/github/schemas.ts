import { z } from "zod";

/**
 * Tolerant schemas for the subset of GitHub REST responses this server uses.
 * Unknown fields are stripped. Only fields needed for triage are required.
 */

const nullableString = (max = 2_000) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((value) => value ?? null);

const nullableInt = () =>
  z
    .number()
    .int()
    .nullish()
    .transform((value) => value ?? null);

const actorSchema = z
  .object({ login: z.string().max(200) })
  .nullish()
  .transform((value) => value ?? null);

export const rawWorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  name: nullableString(500),
  display_title: nullableString(1_000),
  workflow_id: z.number().int().positive(),
  path: nullableString(1_000),
  run_number: nullableInt(),
  run_attempt: nullableInt(),
  event: z.string().max(100).catch("unknown"),
  status: nullableString(50),
  conclusion: nullableString(50),
  head_branch: nullableString(255),
  head_sha: nullableString(100),
  created_at: nullableString(64),
  updated_at: nullableString(64),
  run_started_at: nullableString(64),
  html_url: nullableString(2_000),
  actor: actorSchema,
});

export type RawWorkflowRun = z.infer<typeof rawWorkflowRunSchema>;

export const rawWorkflowRunListSchema = z.object({
  total_count: z.number().int().nonnegative().catch(0),
  workflow_runs: z.array(rawWorkflowRunSchema).catch([]),
});

export const rawStepSchema = z.object({
  // Steps are read-only metadata; only conclusion-bearing fields are used.
  number: nullableInt(),
  name: z.string().max(500).catch("(unnamed step)"),
  status: nullableString(50),
  conclusion: nullableString(50),
  started_at: nullableString(64),
  completed_at: nullableString(64),
});

export const rawJobSchema = z.object({
  id: z.number().int().positive(),
  run_id: nullableInt(),
  run_attempt: nullableInt(),
  name: z.string().max(500).catch("(unnamed job)"),
  status: nullableString(50),
  conclusion: nullableString(50),
  started_at: nullableString(64),
  completed_at: nullableString(64),
  html_url: nullableString(2_000),
  steps: z
    .array(rawStepSchema)
    .nullish()
    .transform((value) => value ?? []),
});

export type RawJob = z.infer<typeof rawJobSchema>;
export type RawStep = z.infer<typeof rawStepSchema>;

export const rawJobListSchema = z.object({
  total_count: z.number().int().nonnegative().catch(0),
  jobs: z.array(rawJobSchema).catch([]),
});

export const rawRepositorySchema = z.object({
  id: z.number().int(),
  full_name: z.string().max(300),
  private: z.boolean().catch(false),
  default_branch: nullableString(255),
  archived: z.boolean().catch(false),
  disabled: z.boolean().catch(false),
  html_url: nullableString(2_000),
  permissions: z
    .object({
      admin: z.boolean().catch(false),
      maintain: z.boolean().catch(false),
      push: z.boolean().catch(false),
      triage: z.boolean().catch(false),
      pull: z.boolean().catch(false),
    })
    .nullish()
    .transform((value) => value ?? null),
});

export const rawWorkflowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().max(500).catch("(unnamed workflow)"),
  path: z.string().max(1_000),
  state: z.string().max(50).catch("unknown"),
  html_url: nullableString(2_000),
  created_at: nullableString(64),
  updated_at: nullableString(64),
});

export const rawContentFileSchema = z.object({
  type: z.string().max(50).optional(),
  path: z.string().max(1_000),
  sha: nullableString(100),
  size: nullableInt(),
  encoding: nullableString(50),
  content: nullableString(3_000_000),
  html_url: nullableString(2_000),
});

export const rawUserSchema = z.object({
  login: z.string().max(200),
});

export const rawRateLimitSchema = z.object({
  resources: z
    .object({
      core: z
        .object({
          limit: z.number().int().nonnegative(),
          used: z.number().int().nonnegative(),
          remaining: z.number().int().nonnegative(),
          reset: z.number().int().nonnegative(),
        })
        .optional(),
    })
    .optional(),
});

export const rawContentDirectorySchema = z.array(
  z.object({
    type: z.string().max(50).optional(),
    name: z.string().max(500).optional(),
    path: z.string().max(1_000).optional(),
  }),
);
