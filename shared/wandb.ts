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

/** A config or summary value; nested config is flattened to dotted keys. */
export const scalarSchema = z.union([z.number(), z.string(), z.boolean(), z.null()]);

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
  tags: z.array(z.string()),
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
  /** How far the run is, when its config names a step or epoch total. */
  progress: z.object({ done: z.number(), total: z.number(), unit: z.enum(["step", "epoch"]) }).nullable(),
  /** Average progress units per second; null until the run has logged. */
  rate: z.number().nullable(),
  /** Seconds left at the average rate, for active runs with a known total. */
  etaSeconds: z.number().nullable(),
  /** Latest GPU use, averaged over the run's GPUs, in percent. */
  gpu: z.object({ util: z.number().nullable(), memory: z.number().nullable(), count: z.number() }).nullable(),
  /** Summary metrics whose latest value is NaN or infinite. */
  nonFinite: z.array(z.string()),
  /** Seconds since the last logged step, when a heartbeating run has gone quiet for unusually long. */
  stalledSeconds: z.number().nullable(),
  /** Flattened config and scalar summary values; only on run queries, not the status poll. */
  config: z.record(z.string(), scalarSchema).optional(),
  summary: z.record(z.string(), scalarSchema).optional(),
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

/**
 * One metric of one run. Each point is [step, runtime seconds, wall-clock seconds, value] so the
 * client can switch the x axis without refetching; system metrics have no step.
 */
export const seriesSchema = z.object({
  key: z.string(),
  points: z.array(z.tuple([z.number().nullable(), z.number().nullable(), z.number().nullable(), z.number()])),
});

export const runHistorySchema = z.object({
  fetchedAt: z.string(),
  metrics: z.array(seriesSchema),
  /** GPU, CPU, and memory use, keyed by a readable label. */
  system: z.array(seriesSchema),
  /** Numeric keys left out to keep the response small. */
  omittedKeys: z.number(),
});

export type Series = z.infer<typeof seriesSchema>;
export type RunHistory = z.infer<typeof runHistorySchema>;
export type Scalar = z.infer<typeof scalarSchema>;

export const runHistoryRpc = defineRpc({
  name: "wandb.history",
  input: z.object({ entity: z.string(), project: z.string(), id: z.string() }),
  output: runHistorySchema,
});

export const projectSchema = z.object({
  entity: z.string(),
  project: z.string(),
  runCount: z.number().nullable(),
  /** ISO time. */
  lastActive: z.string().nullable(),
});
export type WandbProject = z.infer<typeof projectSchema>;

export const projectsRpc = defineRpc({
  name: "wandb.projects",
  input: z.object({}),
  output: z.object({ projects: z.array(projectSchema) }),
});

/**
 * One filter clause. `field` is `config.<key>`, `summary.<key>`, `group`, `jobType`, `host`,
 * `tags`, or `name`; `matches` is a case-insensitive regular expression.
 */
export const filterOpSchema = z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "matches"]);
export const filterClauseSchema = z.object({ field: z.string().min(1), op: filterOpSchema, value: z.string() });
export type FilterOp = z.infer<typeof filterOpSchema>;
export type FilterClause = z.infer<typeof filterClauseSchema>;

/** `created`, `heartbeat`, `name`, `runtime`, `config.<key>`, or `summary.<key>`. */
export const runSortSchema = z.object({ key: z.string().min(1), desc: z.boolean() });
export type RunSort = z.infer<typeof runSortSchema>;

export const stateFilterSchema = z.enum(["all", "running", "finished", "failed", "killed"]);
export type StateFilter = z.infer<typeof stateFilterSchema>;

export const runsQueryRpc = defineRpc({
  name: "wandb.runs",
  input: z.object({
    entity: z.string(),
    project: z.string(),
    search: z.string(),
    state: stateFilterSchema,
    filters: z.array(filterClauseSchema),
    sort: runSortSchema,
    cursor: z.string().nullable(),
  }),
  output: z.object({
    runs: z.array(wandbRunSchema),
    total: z.number().nullable(),
    /** Pass back to load the next page; null on the last page. */
    cursor: z.string().nullable(),
  }),
});

export const runsByKeyRpc = defineRpc({
  name: "wandb.runs-by-key",
  input: z.object({ keys: z.array(z.string()).max(50) }),
  output: z.object({ runs: z.array(wandbRunSchema) }),
});

export const logLineSchema = z.object({
  number: z.number(),
  /** `error` for stderr, which also carries progress bars and warnings. */
  level: z.string(),
  time: z.string().nullable(),
  text: z.string(),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const runLogsRpc = defineRpc({
  name: "wandb.logs",
  input: z.object({ entity: z.string(), project: z.string(), id: z.string() }),
  output: z.object({ lines: z.array(logLineSchema), total: z.number() }),
});

export const stopRunRpc = defineRpc({
  name: "wandb.stop",
  input: z.object({ entity: z.string(), project: z.string(), id: z.string() }),
  output: z.object({ error: z.string().nullable() }),
});

export const reportSummarySchema = z.object({
  /** W&B's view ID, which also forms the report's URL. */
  id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  entity: z.string(),
  project: z.string(),
  author: z.string().nullable(),
  /** ISO time. */
  updatedAt: z.string().nullable(),
  url: z.string(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;

export const reportsRpc = defineRpc({
  name: "wandb.reports",
  input: z.object({ refresh: z.boolean().optional() }),
  output: z.object({ reports: z.array(reportSummarySchema) }),
});

/** A report panel this plugin can draw, or a placeholder for one it cannot. */
export const reportPanelSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("line"),
    title: z.string().nullable(),
    metrics: z.array(z.string()),
    xAxis: z.enum(["step", "runtime", "wall"]),
    /** A custom x metric this plugin cannot plot against; the chart falls back to steps. */
    customX: z.string().nullable(),
    smoothing: z.number(),
    logY: z.boolean(),
    ignoreOutliers: z.boolean(),
  }),
  z.object({ kind: z.literal("scalar"), title: z.string().nullable(), metric: z.string() }),
  z.object({ kind: z.literal("bar"), title: z.string().nullable(), metrics: z.array(z.string()) }),
  z.object({ kind: z.literal("comparer"), diffOnly: z.boolean() }),
  /** Fields are `config.<key>`, `summary.<key>`, or a run field such as `runtime`. */
  z.object({ kind: z.literal("scatter"), title: z.string().nullable(), x: z.string(), y: z.string(), logX: z.boolean(), logY: z.boolean() }),
  z.object({
    kind: z.literal("parallel"),
    title: z.string().nullable(),
    columns: z.array(z.object({ field: z.string(), log: z.boolean(), inverted: z.boolean() })),
  }),
  z.object({ kind: z.literal("markdown"), text: z.string() }),
  z.object({ kind: z.literal("unsupported"), title: z.string().nullable(), type: z.string() }),
]);
export type ReportPanel = z.infer<typeof reportPanelSchema>;

export const reportRunSetSchema = z.object({
  name: z.string(),
  /** The run set's runs, as W&B shows them: filtered, sorted, and capped like its run feed. */
  runKeys: z.array(z.string()),
  /** Runs matching the filters, when more exist than are shown. */
  total: z.number().nullable(),
  /** The run set's grouping, in the explorer's group-by form; empty when ungrouped. */
  groupBy: z.string(),
  /** Why the run set could not be resolved, or a filter that was skipped. */
  note: z.string().nullable(),
});
export type ReportRunSet = z.infer<typeof reportRunSetSchema>;

export const reportBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("markdown"), text: z.string() }),
  z.object({ kind: z.literal("callout"), text: z.string() }),
  z.object({ kind: z.literal("panels"), runSets: z.array(reportRunSetSchema), panels: z.array(reportPanelSchema) }),
  z.object({ kind: z.literal("unsupported"), type: z.string() }),
]);
export type ReportBlock = z.infer<typeof reportBlockSchema>;

/** Points of one metric of one run: [step, runtime, wall time, value, custom x]. */
export const reportSeriesSchema = z.object({
  runKey: z.string(),
  key: z.string(),
  points: z.array(z.tuple([z.number().nullable(), z.number().nullable(), z.number().nullable(), z.number(), z.number().nullable()])),
});
export type ReportSeries = z.infer<typeof reportSeriesSchema>;

/** Just the metrics a report's charts draw, for many runs at once, joined to a custom x metric when one is set. */
export const reportSeriesRpc = defineRpc({
  name: "wandb.report-series",
  input: z.object({ runKeys: z.array(z.string()).max(50), keys: z.array(z.string()).max(30), x: z.string().nullable() }),
  output: z.object({ series: z.array(reportSeriesSchema) }),
});

export const reportRpc = defineRpc({
  name: "wandb.report",
  input: z.object({ id: z.string() }),
  output: z.object({ report: reportSummarySchema, blocks: z.array(reportBlockSchema) }),
});

export const runKey = (entity: string, project: string, id: string) => `${entity}/${project}/${id}`;

export function parseRunKey(key: string): { entity: string; project: string; id: string } | null {
  const parts = key.split("/");
  return parts.length === 3 && parts.every(Boolean) ? { entity: parts[0], project: parts[1], id: parts[2] } : null;
}

/** Runs that are logging or about to. */
export const isActive = (run: WandbRun) => run.state === "running" || run.state === "pending";
