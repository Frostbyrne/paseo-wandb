import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * W&B run states. `running` keeps heartbeating; W&B marks a run `crashed` once its heartbeat
 * stops without a clean finish.
 */
export const runStateSchema = z.enum(["running", "pending", "finished", "failed", "crashed", "killed", "preempted", "unknown"]);

/** How the daemon tied a run to a Paseo workspace. */
export const linkSourceSchema = z.enum(["process", "transcript"]);

export const runLinkSchema = z.object({
  workspaceId: z.string().nullable(),
  terminalId: z.string().nullable(),
  /** The Claude Code session name, such as `project-42`, when known. */
  agentName: z.string().nullable(),
  source: linkSourceSchema,
});

export const wandbRunSchema = z.object({
  /** `entity/project/id`; unique across entities. */
  key: z.string(),
  entity: z.string(),
  project: z.string(),
  id: z.string(),
  name: z.string(),
  state: runStateSchema,
  /** ISO times. */
  createdAt: z.string(),
  heartbeatAt: z.string().nullable(),
  /** Seconds, from the run summary. */
  runtime: z.number().nullable(),
  step: z.number().nullable(),
  host: z.string().nullable(),
  group: z.string().nullable(),
  jobType: z.string().nullable(),
  url: z.string(),
  link: runLinkSchema.nullable(),
  /** `project › workspace` for the linked workspace, when the daemon knows it. */
  workspaceLabel: z.string().nullable(),
  /** The metric the list shows for this run, chosen from its summary. */
  headline: z
    .object({
      key: z.string(),
      value: z.number(),
      /** Recent values, oldest first; empty when unavailable. */
      recent: z.array(z.number()),
    })
    .nullable(),
});

export const wandbStatusSchema = z.object({
  /** ISO time of the last successful fetch; null until one succeeds. */
  fetchedAt: z.string().nullable(),
  /** The W&B username the key belongs to. */
  user: z.string().nullable(),
  appUrl: z.string(),
  /** The last successful fetch's runs, active first; still shown when `error` is set. */
  runs: z.array(wandbRunSchema),
  error: z.string().nullable(),
});

export type RunState = z.infer<typeof runStateSchema>;
export type RunLink = z.infer<typeof runLinkSchema>;
export type WandbRun = z.infer<typeof wandbRunSchema>;
export type WandbStatus = z.infer<typeof wandbStatusSchema>;

export const wandbStatusRpc = defineRpc({
  name: "wandb.status",
  input: z.object({ refresh: z.boolean().optional() }),
  output: wandbStatusSchema,
});

/** One chart: `points` are [x, y] pairs in x order. */
export const seriesSchema = z.object({
  key: z.string(),
  xLabel: z.string(),
  points: z.array(z.tuple([z.number(), z.number()])),
});

export const runHistorySchema = z.object({
  fetchedAt: z.string(),
  metrics: z.array(seriesSchema),
  /** GPU and CPU charts against runtime in minutes. */
  system: z.array(seriesSchema),
  /** Numeric keys left out to keep the response small. */
  omittedKeys: z.number(),
});

export type Series = z.infer<typeof seriesSchema>;
export type RunHistory = z.infer<typeof runHistorySchema>;

export const runHistoryRpc = defineRpc({
  name: "wandb.history",
  input: z.object({ entity: z.string(), project: z.string(), id: z.string() }),
  output: runHistorySchema,
});

export const runKey = (entity: string, project: string, id: string) => `${entity}/${project}/${id}`;

/** Runs that are logging or about to. */
export const isActive = (run: WandbRun) => run.state === "running" || run.state === "pending";
