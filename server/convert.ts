import { runKey, type RunState, type Scalar, type WandbRun } from "../shared/wandb";

/** Config keys that commonly hold a run's planned length, in order of preference. */
const STEP_TOTAL_KEYS = ["total_steps", "max_steps", "num_steps", "train_steps", "num_train_steps", "steps", "max_iters", "total_iters", "iterations", "num_iterations", "n_steps"];
const EPOCH_TOTAL_KEYS = ["epochs", "num_epochs", "max_epochs", "n_epochs", "num_train_epochs"];

/** GraphQL selections for a run row; details add config and tags for comparisons. */
export const RUN_FIELDS = `name displayName state createdAt heartbeatAt host group jobType tags summaryMetrics systemMetrics progressConfig: config(keys: ${JSON.stringify([...STEP_TOTAL_KEYS, ...EPOCH_TOTAL_KEYS])})`;
export const RUN_DETAIL_FIELDS = `${RUN_FIELDS} config`;

export interface RawRun {
  name: string;
  displayName: string | null;
  state: string | null;
  createdAt: string;
  heartbeatAt: string | null;
  host: string | null;
  group: string | null;
  jobType: string | null;
  tags?: string[] | null;
  summaryMetrics: string | null;
  systemMetrics?: string | null;
  progressConfig?: string | null;
  config?: string | null;
}

const RUN_STATES = new Set<RunState>(["running", "pending", "finished", "failed", "crashed", "killed", "preempted"]);
/** Keeps a run row small even for runs that log hundreds of config or summary keys. */
const MAX_VALUES = 300;
const MAX_TEXT = 200;

/** W&B returns UTC times without a zone. */
export const parseTime = (value: string | null) => (value ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) : NaN);
const isoTime = (value: string | null) => (value && Number.isFinite(parseTime(value)) ? new Date(parseTime(value)).toISOString() : null);

export const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** What a NaN or infinite summary value parses to; W&B writes them as bare JSON tokens. */
const NON_FINITE = "__non_finite__";

export function parseObject(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  const parse = (json: string) => {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  };
  try {
    return parse(text);
  } catch {
    try {
      return parse(text.replace(/([:[,]\s*)(-?Infinity|NaN)(?=\s*[,}\]])/g, `$1"${NON_FINITE}$2"`));
    } catch {
      return {};
    }
  }
}

const nonFiniteText = (value: unknown) =>
  typeof value === "string" && (value.startsWith(NON_FINITE) || value === "NaN" || value === "Infinity" || value === "-Infinity")
    ? value.replace(NON_FINITE, "")
    : null;

export const isChartKey = (key: string) => !key.startsWith("_") && !key.startsWith("system/") && !key.startsWith("system.");

function toScalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === "boolean") return value;
  const nonFinite = nonFiniteText(value);
  if (nonFinite) return nonFinite;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  if (Array.isArray(value)) {
    const text = JSON.stringify(value);
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  return undefined;
}

/** Config as dotted keys: W&B stores `{key: {value}}` and values may nest. */
function flattenConfig(config: Record<string, unknown>): Record<string, Scalar> {
  const flat: Record<string, Scalar> = {};
  let count = 0;
  const visit = (prefix: string, value: unknown) => {
    if (count >= MAX_VALUES) return;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) visit(prefix ? `${prefix}.${key}` : key, inner);
      return;
    }
    const scalar = toScalar(value);
    if (scalar !== undefined) {
      flat[prefix] = scalar;
      count++;
    }
  };
  for (const [key, entry] of Object.entries(config)) {
    if (key.startsWith("_wandb")) continue;
    visit(key, entry && typeof entry === "object" && "value" in entry ? (entry as { value: unknown }).value : entry);
  }
  return flat;
}

/** Scalar summary values; histograms, tables, and media are left out. */
function scalarSummary(summary: Record<string, unknown>): Record<string, Scalar> {
  const flat: Record<string, Scalar> = {};
  for (const key of Object.keys(summary).sort()) {
    if (key.startsWith("_") || Object.keys(flat).length >= MAX_VALUES) continue;
    const value = summary[key];
    if (value !== null && typeof value === "object") continue;
    const scalar = toScalar(value);
    if (scalar !== undefined) flat[key] = scalar;
  }
  return flat;
}

/** The metric a list row shows: a loss if there is one, then reward, then accuracy. */
function pickHeadline(summary: Record<string, unknown>): { key: string; value: number } | null {
  const rank = (key: string) => {
    const leaf = key.split("/").pop()!.toLowerCase();
    if (leaf === "loss") return key.startsWith("train") || !key.includes("/") ? 0 : 1;
    if (leaf.includes("loss")) return 2;
    if (leaf.includes("reward")) return 3;
    if (leaf.includes("acc")) return 4;
    return 9;
  };
  const candidates = Object.entries(summary)
    .filter((entry): entry is [string, number] => isChartKey(entry[0]) && typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .sort(([a], [b]) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b));
  return candidates[0] ? { key: candidates[0][0], value: candidates[0][1] } : null;
}

const numeric = (value: unknown) => {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
};

/** The planned length from config, matched against how far the summary says the run got. */
function progressOf(summary: Record<string, unknown>, config: Record<string, unknown>): WandbRun["progress"] {
  const configValue = (key: string) => {
    const entry = config[key];
    return numeric(entry && typeof entry === "object" && "value" in entry ? (entry as { value: unknown }).value : entry);
  };
  const step = numberOrNull(summary._step);
  for (const key of STEP_TOTAL_KEYS) {
    const total = configValue(key);
    // Logged steps only measure progress when the run logs once per step; past the total they do not.
    if (total && total > 0 && step !== null && step <= total * 1.05) return { done: Math.min(step, total), total, unit: "step" };
  }
  const epoch = numberOrNull(summary.epoch) ?? numberOrNull(summary.epochs);
  for (const key of EPOCH_TOTAL_KEYS) {
    const total = configValue(key);
    if (total && total > 0 && epoch !== null && epoch <= total * 1.05) return { done: Math.min(epoch, total), total, unit: "epoch" };
  }
  return null;
}

/** Average utilization and memory of the run's GPUs from its latest system metrics. */
function gpuOf(system: Record<string, unknown>): WandbRun["gpu"] {
  const util: number[] = [];
  const memory: number[] = [];
  for (const [key, value] of Object.entries(system)) {
    const match = key.match(/^system\.gpu\.(\d+)\.(gpu|memoryAllocated)$/);
    const number = numberOrNull(value);
    if (!match || number === null) continue;
    (match[2] === "gpu" ? util : memory).push(number);
  }
  const count = Math.max(util.length, memory.length);
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  return count ? { util: mean(util), memory: mean(memory), count } : null;
}

/** A heartbeating run that stopped logging for 10 minutes, or 5 of its average step times if longer. */
function stalledFor(summary: Record<string, unknown>, raw: RawRun, active: boolean): number | null {
  const runtime = numberOrNull(summary._runtime);
  const step = numberOrNull(summary._step);
  const started = parseTime(raw.createdAt);
  const heartbeat = parseTime(raw.heartbeatAt);
  if (!active || runtime === null || !Number.isFinite(started) || !Number.isFinite(heartbeat)) return null;
  // `_runtime` is stamped by each logged row, so the gap to the heartbeat is the time since the last one.
  const quiet = (heartbeat - started) / 1000 - runtime;
  const threshold = Math.max(600, step ? (5 * runtime) / step : 0);
  return quiet > threshold ? Math.round(quiet) : null;
}

export function toRun(entity: string, project: string, raw: RawRun, app: string, details: boolean): WandbRun {
  const summary = parseObject(raw.summaryMetrics);
  const state = (raw.state ?? "unknown") as RunState;
  const active = state === "running" || state === "pending";
  const headline = pickHeadline(summary);
  const runtime = numberOrNull(summary._runtime) ?? numberOrNull(summary["_wandb.runtime"]);
  const progress = progressOf(summary, parseObject(raw.progressConfig));
  const rate = progress && runtime && progress.done > 0 ? progress.done / runtime : null;
  return {
    key: runKey(entity, project, raw.name),
    entity,
    project,
    id: raw.name,
    name: raw.displayName || raw.name,
    state: RUN_STATES.has(state) ? state : "unknown",
    createdAt: isoTime(raw.createdAt) ?? raw.createdAt,
    heartbeatAt: isoTime(raw.heartbeatAt),
    runtime,
    step: numberOrNull(summary._step),
    host: raw.host,
    group: raw.group,
    jobType: raw.jobType,
    tags: raw.tags ?? [],
    url: `${app}/${encodeURIComponent(entity)}/${encodeURIComponent(project)}/runs/${encodeURIComponent(raw.name)}`,
    link: null,
    workspaceLabel: null,
    headline: headline ? { ...headline, recent: [] } : null,
    progress,
    rate,
    etaSeconds: active && progress && rate ? Math.max(0, (progress.total - progress.done) / rate) : null,
    gpu: active ? gpuOf(parseObject(raw.systemMetrics)) : null,
    nonFinite: Object.keys(summary).filter((key) => isChartKey(key) && nonFiniteText(summary[key]) !== null),
    stalledSeconds: stalledFor(summary, raw, active),
    ...(details ? { config: flattenConfig(parseObject(raw.config)), summary: scalarSummary(summary) } : {}),
  };
}
