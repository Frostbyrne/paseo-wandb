/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  type ReportBlock,
  type ReportPanel,
  type ReportRunSet,
  type ReportSummary,
  type reportRpc,
  type reportSeriesRpc,
  type reportsRpc,
  parseRunKey,
  runKey,
} from "../shared/wandb";
import { appUrl, batched, type Credentials, graphql, WandbError } from "./api";
import { numberOrNull, parseObject } from "./convert";
import { getProjects, getViewer, requireCredentials, useHandlerContext } from "./wandb";

const REPORTS_CACHE_MS = 60_000;
const REPORTS_PER_PROJECT = 50;
/** Runs per run set, as W&B's run feed shows by default, within what one comparison request takes. */
const MAX_RUNS_PER_SET = 25;
const MAX_RUNS_PER_GRID = 50;
const SERIES_SAMPLES = 300;
const SERIES_CACHE_MS = 15_000;

type Node = { type?: string; text?: string; children?: Node[] } & Record<string, unknown>;

interface RawView {
  id: string;
  displayName: string | null;
  description: string | null;
  updatedAt: string | null;
  user: { username: string | null } | null;
}

let reportsCache: { at: number; reports: ReportSummary[] } | null = null;

function reportUrl(app: string, entity: string, project: string, id: string, title: string): string {
  const slug = title.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  return `${app}/${encodeURIComponent(entity)}/${encodeURIComponent(project)}/reports/${slug}--${id}`;
}

function toSummary(app: string, entity: string, project: string, view: RawView): ReportSummary {
  const title = view.displayName || "Untitled report";
  return {
    id: view.id,
    title,
    description: view.description || null,
    entity,
    project,
    author: view.user?.username ?? null,
    updatedAt: view.updatedAt ? new Date(/[zZ]$/.test(view.updatedAt) ? view.updatedAt : `${view.updatedAt}Z`).toISOString() : null,
    url: reportUrl(app, entity, project, view.id, title),
  };
}

export async function listReports({ refresh }: RpcInput<typeof reportsRpc>, context: PluginHandlerContext): Promise<RpcOutput<typeof reportsRpc>> {
  useHandlerContext(context);
  if (!refresh && reportsCache && Date.now() - reportsCache.at < REPORTS_CACHE_MS) return { reports: reportsCache.reports };
  const credentials = await requireCredentials();
  const viewer = await getViewer(credentials);
  const projects = await getProjects(credentials, viewer.entities);
  const results = await batched<(typeof projects)[number], { allViews: { edges: { node: RawView }[] } | null }>(
    credentials,
    projects,
    25,
    (index) => `$e${index}: String!, $p${index}: String!`,
    (index) =>
      `project(name: $p${index}, entityName: $e${index}) { allViews(viewType: "runs", first: ${REPORTS_PER_PROJECT}) { edges { node { id displayName description updatedAt user { username } } } } }`,
    ({ entity, project }, index) => ({ [`e${index}`]: entity, [`p${index}`]: project }),
  );
  const app = appUrl(credentials.baseUrl);
  const reports = projects
    .flatMap(({ entity, project }, index) => (results[index]?.allViews?.edges ?? []).map(({ node }) => toSummary(app, entity, project, node)))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  reportsCache = { at: Date.now(), reports };
  return { reports };
}

// Reports are views of type "runs"; drafts and saved workspaces have other types.

// Text blocks become Markdown, which Paseo's own renderer draws.

function inline(nodes: Node[] | undefined): string {
  return (nodes ?? [])
    .map((node) => {
      if (node.type === "link") return `[${inline(node.children)}](${String(node.url ?? "")})`;
      if (node.type === "latex") return `$${String(node.content ?? "")}$`;
      if (typeof node.text === "string") {
        let text = node.text;
        if (!text.trim()) return text;
        if (node.inlineCode) return `\`${text}\``;
        if (node.bold || node.strong) text = `**${text}**`;
        if (node.italic || node.emphasis) text = `_${text}_`;
        if (node.strikethrough) text = `~~${text}~~`;
        return text;
      }
      return inline(node.children);
    })
    .join("");
}

function listMarkdown(node: Node, depth: number): string {
  const ordered = Boolean(node.ordered);
  return (node.children ?? [])
    .map((item, index) => {
      const marker = ordered ? `${index + 1}.` : typeof item.checked === "boolean" ? `- [${item.checked ? "x" : " "}]` : "-";
      const indent = "  ".repeat(depth);
      const text = (item.children ?? [])
        .filter((child) => child.type !== "list")
        .map((child) => inline(child.type === "paragraph" ? child.children : [child]))
        .join(" ");
      const nested = (item.children ?? []).filter((child) => child.type === "list").map((child) => listMarkdown(child, depth + 1));
      return [`${indent}${marker} ${text}`, ...nested].join("\n");
    })
    .join("\n");
}

function headingsOf(blocks: Node[]): string {
  return blocks
    .filter((block) => block.type === "heading")
    .map((block) => `${"  ".repeat(Math.max(0, Number(block.level ?? 1) - 1))}- ${inline(block.children)}`)
    .join("\n");
}

/** Markdown for a text block; null for blocks that are not text. */
function blockMarkdown(block: Node, all: Node[]): string | null {
  switch (block.type) {
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(block.level ?? 1))))} ${inline(block.children)}`;
    case "paragraph":
      return inline(block.children);
    case "list":
      return listMarkdown(block, 0);
    case "code-block": {
      const lines = (block.children ?? []).map((line) => (line.children ?? []).map((part) => part.text ?? "").join(""));
      return `\`\`\`${String(block.language ?? "")}\n${lines.join("\n")}\n\`\`\``;
    }
    case "markdown-block":
      return String(block.content ?? "");
    case "block-quote":
      return inline(block.children)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "horizontal-rule":
      return "---";
    case "image": {
      const caption = inline(block.children).trim();
      return block.url ? `![${caption}](${String(block.url)})${caption ? `\n\n_${caption}_` : ""}` : null;
    }
    case "latex":
      return `\`\`\`latex\n${String(block.content ?? "")}\n\`\`\``;
    case "table-of-contents": {
      const headings = headingsOf(all);
      return headings ? `**Contents**\n\n${headings}` : null;
    }
    default:
      return null;
  }
}

// Run sets use W&B's own filter format; they are translated to the run query's filters.

const RUN_FIELDS: Record<string, string> = {
  displayName: "display_name",
  name: "name",
  state: "state",
  createdAt: "created_at",
  heartbeatAt: "heartbeat_at",
  updatedAt: "heartbeat_at",
  group: "group",
  jobType: "jobType",
  host: "host",
  username: "username",
  sweep: "sweep",
  runtime: "summary_metrics._runtime",
  duration: "summary_metrics._runtime",
};

function fieldPath(key: { section?: string; name?: string } | undefined): string | null {
  const name = key?.name;
  if (!name) return null;
  if (key.section === "config") return `config.${name.replace(/\.value$/, "")}`;
  if (key.section === "summary") return `summary_metrics.${name}`;
  if (key.section === "run") return RUN_FIELDS[name] ?? null;
  return null;
}

type Leaf = { key?: { section?: string; name?: string }; op?: string; value?: unknown; disabled?: boolean };
type Tree = { op?: string; filters?: (Tree | Leaf)[]; filterFormat?: string };

function leafFilter(leaf: Leaf, skipped: string[]): Record<string, unknown> | null {
  if (leaf.disabled) return null;
  if (leaf.key?.section === "tags" && leaf.key.name) {
    return { tags: leaf.value === false ? { $nin: [leaf.key.name] } : { $in: [leaf.key.name] } };
  }
  if (leaf.key?.section === "run" && leaf.key.name === "tags") {
    const tags = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
    if (leaf.op === "IN" || leaf.op === "=") return { tags: { $in: tags } };
    if (leaf.op === "NIN" || leaf.op === "!=") return { tags: { $nin: tags } };
  }
  const path = fieldPath(leaf.key);
  const label = `${leaf.key?.section ?? "?"}.${leaf.key?.name ?? "?"} ${leaf.op ?? ""}`;
  if (!path) {
    skipped.push(label);
    return null;
  }
  const value = leaf.value;
  switch (leaf.op) {
    case "=":
      return { [path]: value };
    case "!=":
      return { [path]: { $ne: value } };
    case "<":
      return { [path]: { $lt: value } };
    case ">":
      return { [path]: { $gt: value } };
    case "<=":
      return { [path]: { $lte: value } };
    case ">=":
      return { [path]: { $gte: value } };
    case "IN":
      return { [path]: { $in: Array.isArray(value) ? value : [value] } };
    case "NIN":
      return { [path]: { $nin: Array.isArray(value) ? value : [value] } };
    case "=~":
    case "REGEX":
      return { [path]: { $regex: String(value) } };
    case "WITHINSECONDS":
      return { [path]: { $gt: new Date(Date.now() - Number(value) * 1000).toISOString() } };
    default:
      skipped.push(label);
      return null;
  }
}

function treeFilter(node: Tree | Leaf | undefined, skipped: string[]): Record<string, unknown> | null {
  if (!node) return null;
  if ("filters" in node && Array.isArray(node.filters)) {
    const parts = node.filters.map((child) => treeFilter(child, skipped)).filter((part): part is Record<string, unknown> => part !== null);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    return node.op === "OR" ? { $or: parts } : { $and: parts };
  }
  return leafFilter(node as Leaf, skipped);
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function sortOrder(sort: unknown): string {
  const first = (sort as { keys?: { key?: { section?: string; name?: string }; ascending?: boolean }[] } | undefined)?.keys?.[0];
  const path = fieldPath(first?.key) ?? "created_at";
  return `${first?.ascending ? "+" : "-"}${path}`;
}

function groupByOf(grouping: unknown): string {
  const first = Array.isArray(grouping) ? (grouping[0] as { section?: string; name?: string } | undefined) : undefined;
  if (!first?.name) return "";
  if (first.section === "config") return `config.${first.name.replace(/\.value$/, "")}`;
  if (first.section === "run" && (first.name === "group" || first.name === "jobType")) return first.name;
  return "";
}

async function resolveRunSet(credentials: Credentials, raw: Record<string, unknown>): Promise<ReportRunSet | null> {
  if (raw.enabled === false) return null;
  const project = raw.project as { name?: string; entityName?: string } | undefined;
  const name = String(raw.name ?? "Run set");
  if (!project?.name || !project.entityName) return { name, runKeys: [], total: null, groupBy: "", note: "The run set has no project." };
  const skipped: string[] = [];
  const parts: Record<string, unknown>[] = [];
  const filter = treeFilter(raw.filters as Tree | undefined, skipped);
  if (filter) parts.push(filter);
  const search = raw.search as { query?: string; regex?: boolean } | undefined;
  if (search?.query?.trim()) parts.push({ display_name: { $regex: search.regex ? search.query : escapeRegex(search.query) } });
  const selections = raw.selections as { root?: number; tree?: unknown[] } | undefined;
  const picked = (selections?.tree ?? []).filter((item): item is string => typeof item === "string");
  // Root 1 selects every run except those in the tree; root 0 selects only those in it.
  if (selections?.root === 0) parts.push({ name: { $in: picked } });
  else if (picked.length) parts.push({ name: { $nin: picked } });
  const pageSize = Math.min(MAX_RUNS_PER_SET, Number((raw.runFeed as { pageSize?: number } | undefined)?.pageSize) || 10);
  const data = await graphql<{ project: { runs: { totalCount: number | null; edges: { node: { name: string } }[] } | null } | null }>(
    credentials,
    `query($e: String!, $p: String!, $f: JSONString, $o: String) { project(name: $p, entityName: $e) { runs(first: ${pageSize}, filters: $f, order: $o) { totalCount edges { node { name } } } } }`,
    {
      e: project.entityName,
      p: project.name,
      f: parts.length ? JSON.stringify(parts.length === 1 ? parts[0] : { $and: parts }) : null,
      o: sortOrder(raw.sort),
    },
  );
  const runs = data.project?.runs;
  return {
    name,
    runKeys: (runs?.edges ?? []).map(({ node }) => runKey(project.entityName!, project.name!, node.name)),
    total: runs?.totalCount ?? null,
    groupBy: groupByOf(raw.grouping),
    note: !data.project ? `W&B has no project ${project.entityName}/${project.name}.` : skipped.length ? `Some filters were left out: ${skipped.join(", ")}.` : null,
  };
}

/** `config:lr.value`, `summary:loss`, or `run:runtime` as the plugin's field names. */
function accessorField(accessor: unknown): string | null {
  if (typeof accessor !== "string") return null;
  const [section, ...rest] = accessor.split(":");
  const name = rest.join(":");
  if (!name) return null;
  if (section === "config") return `config.${name.replace(/\.value$/, "")}`;
  if (section === "summary") return `summary.${name}`;
  if (section === "run") return name;
  return null;
}

function toPanel(raw: Record<string, unknown>): ReportPanel {
  const config = (raw.config ?? {}) as Record<string, unknown>;
  const title = typeof config.chartTitle === "string" && config.chartTitle ? config.chartTitle : null;
  const metrics = Array.isArray(config.metrics) ? config.metrics.filter((metric): metric is string => typeof metric === "string") : [];
  switch (raw.viewType) {
    case "Run History Line Plot": {
      const x = typeof config.xAxis === "string" ? config.xAxis : "_step";
      const xAxis = x === "_runtime" ? "runtime" : x === "_timestamp" ? "wall" : "step";
      return {
        kind: "line",
        title,
        metrics,
        xAxis,
        customX: x === "_step" || x === "_runtime" || x === "_timestamp" ? null : x,
        smoothing: Math.min(0.99, Math.max(0, Number(config.smoothingWeight) || 0)),
        logY: Boolean(config.yLogScale),
        ignoreOutliers: Boolean(config.ignoreOutliers),
      };
    }
    case "Scalar Chart":
      return metrics[0] ? { kind: "scalar", title, metric: metrics[0] } : { kind: "unsupported", title, type: "Scalar chart" };
    case "Bar Chart":
      return { kind: "bar", title, metrics: metrics.map((metric) => metric.replace(/^summary_metrics\./, "")) };
    case "Run Comparer":
      return { kind: "comparer", diffOnly: Boolean(config.diffOnly) };
    case "Scatter Plot": {
      const x = accessorField(config.xAxis);
      const y = accessorField(config.yAxis);
      return x && y
        ? { kind: "scatter", title, x, y, logX: Boolean(config.xAxisLog), logY: Boolean(config.yAxisLog) }
        : { kind: "unsupported", title, type: "Scatter plot" };
    }
    case "Parallel Coordinates Plot": {
      const columns = (Array.isArray(config.columns) ? config.columns : [])
        .map((column: { accessor?: unknown; log?: unknown; inverted?: unknown }) => ({
          field: accessorField(column.accessor),
          log: Boolean(column.log),
          inverted: Boolean(column.inverted),
        }))
        .filter((column): column is { field: string; log: boolean; inverted: boolean } => column.field !== null);
      return columns.length >= 2 ? { kind: "parallel", title, columns } : { kind: "unsupported", title, type: "Parallel coordinates" };
    }
    case "Markdown Panel":
      return { kind: "markdown", text: String(config.value ?? "") };
    default:
      return { kind: "unsupported", title, type: String(raw.viewType ?? "panel") };
  }
}

async function panelBlock(credentials: Credentials, metadata: Record<string, unknown>): Promise<ReportBlock> {
  const runSets = Array.isArray(metadata.runSets) ? (metadata.runSets as Record<string, unknown>[]) : [];
  const section = metadata.panelBankSectionConfig as { panels?: Record<string, unknown>[] } | undefined;
  const panels = (section?.panels ?? (metadata.panels as { views?: Record<string, unknown> } | undefined)?.views ?? []) as Record<string, unknown>[];
  const resolved = await Promise.all(
    runSets.map((runSet) =>
      resolveRunSet(credentials, runSet).catch((error: unknown) => ({
        name: String(runSet.name ?? "Run set"),
        runKeys: [],
        total: null,
        groupBy: "",
        note: error instanceof Error ? error.message : String(error),
      })),
    ),
  );
  // One comparison request takes 50 runs; later run sets give up their runs first.
  let budget = MAX_RUNS_PER_GRID;
  const kept = resolved
    .filter((runSet): runSet is ReportRunSet => runSet !== null)
    .map((runSet) => {
      const runKeys = runSet.runKeys.slice(0, Math.max(0, budget));
      budget -= runKeys.length;
      return { ...runSet, runKeys };
    });
  return { kind: "panels", runSets: kept, panels: (Array.isArray(panels) ? panels : []).map(toPanel) };
}

export async function getReport({ id }: RpcInput<typeof reportRpc>, context: PluginHandlerContext): Promise<RpcOutput<typeof reportRpc>> {
  useHandlerContext(context);
  const credentials = await requireCredentials();
  const data = await graphql<{
    view: (RawView & { spec: string | null; project: { name: string; entityName: string } | null }) | null;
  }>(credentials, "query($id: ID!) { view(id: $id) { id displayName description updatedAt user { username } project { name entityName } spec } }", { id });
  const view = data.view;
  if (!view?.project) throw new WandbError("W&B has no report with that ID, or this key cannot read it.");
  const spec = parseObject(view.spec);
  const raw = (Array.isArray(spec.blocks) ? spec.blocks : []) as Node[];
  const blocks: ReportBlock[] = [];
  let text: string[] = [];
  const flush = () => {
    const markdown = text.filter((part) => part.trim()).join("\n\n");
    if (markdown) blocks.push({ kind: "markdown", text: markdown });
    text = [];
  };
  for (const block of raw) {
    const markdown = blockMarkdown(block, raw);
    if (markdown !== null) {
      text.push(markdown);
      continue;
    }
    flush();
    if (block.type === "panel-grid") blocks.push(await panelBlock(credentials, (block.metadata ?? {}) as Record<string, unknown>));
    else if (block.type === "callout-block") {
      blocks.push({ kind: "callout", text: (block.children ?? []).map((line) => inline(line.children)).join("\n\n") });
    } else blocks.push({ kind: "unsupported", type: String(block.type ?? "block") });
  }
  flush();
  return { report: toSummary(appUrl(credentials.baseUrl), view.project.entityName, view.project.name, view), blocks };
}

const seriesCache = new Map<string, { at: number; series: RpcOutput<typeof reportSeriesRpc>["series"] }>();

/** Sampled points of `keys` for each run, in one request per ten runs; a custom x joins on the same logged rows. */
export async function getReportSeries({ runKeys, keys, x }: RpcInput<typeof reportSeriesRpc>): Promise<RpcOutput<typeof reportSeriesRpc>> {
  const cacheKey = JSON.stringify([runKeys, keys, x]);
  const cached = seriesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SERIES_CACHE_MS) return { series: cached.series };
  const credentials = await requireCredentials();
  const runs = runKeys.map(parseRunKey).filter((key): key is NonNullable<typeof key> => key !== null);
  const specs = keys.map((key) => JSON.stringify({ keys: ["_step", "_runtime", "_timestamp", ...(x ? [x] : []), key], samples: SERIES_SAMPLES }));
  const results = await batched<(typeof runs)[number], { run: { sampledHistory: Record<string, unknown>[][] | null } | null }>(
    credentials,
    runs,
    10,
    (index) => `$e${index}: String!, $p${index}: String!, $r${index}: String!`,
    (index) => `project(name: $p${index}, entityName: $e${index}) { run(name: $r${index}) { sampledHistory(specs: $s) } }`,
    (run, index) => ({ [`e${index}`]: run.entity, [`p${index}`]: run.project, [`r${index}`]: run.id }),
    { declarations: "$s: [JSONString!]!", variables: { s: specs } },
  );
  const series: RpcOutput<typeof reportSeriesRpc>["series"] = [];
  runs.forEach((run, runIndex) => {
    const sampled = results[runIndex]?.run?.sampledHistory ?? [];
    keys.forEach((key, keyIndex) => {
      const points = (sampled[keyIndex] ?? [])
        .map((row) => [numberOrNull(row._step), numberOrNull(row._runtime), numberOrNull(row._timestamp), numberOrNull(row[key]), x ? numberOrNull(row[x]) : null] as const)
        .filter((point): point is readonly [number | null, number | null, number | null, number, number | null] => point[3] !== null)
        .map((point) => [...point] as [number | null, number | null, number | null, number, number | null]);
      series.push({ runKey: runKey(run.entity, run.project, run.id), key, points });
    });
  });
  seriesCache.set(cacheKey, { at: Date.now(), series });
  for (const [entryKey, entry] of seriesCache) {
    if (Date.now() - entry.at > 5 * 60_000) seriesCache.delete(entryKey);
  }
  return { series };
}
