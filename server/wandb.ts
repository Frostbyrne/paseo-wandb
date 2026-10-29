/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  isActive,
  runKey,
  type RunHistory,
  type RunState,
  type Series,
  type WandbRun,
  type WandbStatus,
  type runHistoryRpc,
  type wandbStatusRpc,
} from "../shared/wandb";
import { appUrl, batched, type Credentials, graphql, loadCredentials, WandbError } from "./api";
import { RunLinker } from "./links";

// Every open surface polls; this keeps several windows and hosts to one round of W&B calls.
const STATUS_CACHE_MS = 15_000;
const HISTORY_CACHE_MS = 15_000;
const VIEWER_CACHE_MS = 10 * 60_000;
const PROJECTS_CACHE_MS = 5 * 60_000;
/** Ended runs stay listed this long after their last heartbeat. */
const RECENT_MS = 6 * 3600_000;
const MAX_RUNS = 30;
const RUNS_PER_PROJECT = 50;
const SPARK_SAMPLES = 40;
const HISTORY_SAMPLES = 300;
const MAX_CHART_KEYS = 48;

const RUN_STATES = new Set<RunState>(["running", "pending", "finished", "failed", "crashed", "killed", "preempted"]);

interface Viewer {
  username: string;
  entities: string[];
}

interface RawRun {
  name: string;
  displayName: string | null;
  state: string | null;
  createdAt: string;
  heartbeatAt: string | null;
  host: string | null;
  group: string | null;
  jobType: string | null;
  summaryMetrics: string | null;
}

const linker = new RunLinker();
let viewerCache: { at: number; baseUrl: string; viewer: Viewer } | null = null;
let projectsCache: { at: number; baseUrl: string; projects: { entity: string; project: string }[] } | null = null;
let statusCache: { at: number; status: WandbStatus } | null = null;
let inFlight: Promise<WandbStatus> | null = null;
const historyCache = new Map<string, { at: number; history: RunHistory }>();
const labelCache = new Map<string, { at: number; label: string | null }>();
let paseo: PluginHandlerContext["paseo"] | null = null;

/** W&B returns UTC times without a zone. */
const parseTime = (value: string | null) => (value ? Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`) : NaN);
const isoTime = (value: string | null) => (value && Number.isFinite(parseTime(value)) ? new Date(parseTime(value)).toISOString() : null);

async function getViewer(credentials: Credentials): Promise<Viewer> {
  if (viewerCache && viewerCache.baseUrl === credentials.baseUrl && Date.now() - viewerCache.at < VIEWER_CACHE_MS) {
    return viewerCache.viewer;
  }
  const data = await graphql<{
    viewer: { username: string; entity: string; teams: { edges: { node: { name: string } }[] } | null } | null;
  }>(credentials, "{ viewer { username entity teams { edges { node { name } } } } }");
  if (!data.viewer) throw new WandbError("W&B did not return the account for this API key.");
  const entities = [data.viewer.entity, ...(data.viewer.teams?.edges.map((edge) => edge.node.name) ?? [])];
  const viewer = { username: data.viewer.username, entities: [...new Set(entities.filter(Boolean))] };
  viewerCache = { at: Date.now(), baseUrl: credentials.baseUrl, viewer };
  return viewer;
}

async function getProjects(credentials: Credentials, entities: string[]) {
  if (projectsCache && projectsCache.baseUrl === credentials.baseUrl && Date.now() - projectsCache.at < PROJECTS_CACHE_MS) {
    return projectsCache.projects;
  }
  const results = await batched<string, { edges: { node: { name: string } }[] }>(
    credentials,
    entities,
    10,
    (index) => `$e${index}: String!`,
    (index) => `models(entityName: $e${index}, first: 100) { edges { node { name } } }`,
    (entity, index) => ({ [`e${index}`]: entity }),
  );
  const projects = entities.flatMap((entity, index) =>
    (results[index]?.edges ?? []).map((edge) => ({ entity, project: edge.node.name })),
  );
  projectsCache = { at: Date.now(), baseUrl: credentials.baseUrl, projects };
  return projects;
}

function parseSummary(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const isChartKey = (key: string) => !key.startsWith("_") && !key.startsWith("system/") && !key.startsWith("system.");

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

/** `project › workspace` labels for the linked workspaces; null for ones the daemon no longer has. */
async function workspaceLabels(ids: string[]): Promise<Map<string, string | null>> {
  const labels = new Map<string, string | null>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const cached = labelCache.get(id);
      if (cached && Date.now() - cached.at < 60_000) return labels.set(id, cached.label);
      if (!paseo) return;
      try {
        const { entries } = await paseo.workspaces.list({ filter: { idPrefix: id, includeBackground: true } });
        const workspace = entries.find((entry) => entry.id === id);
        const label = workspace ? `${workspace.projectDisplayName} › ${workspace.title || workspace.name}` : null;
        labelCache.set(id, { at: Date.now(), label });
        labels.set(id, label);
      } catch (error) {
        console.error("Could not look up workspace", id, error);
      }
    }),
  );
  return labels;
}

const numberOrNull = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

async function fetchRuns(credentials: Credentials, projects: { entity: string; project: string }[]) {
  const filters = JSON.stringify({
    $or: [{ state: "running" }, { state: "pending" }, { heartbeatAt: { $gt: new Date(Date.now() - RECENT_MS).toISOString() } }],
  });
  const results = await batched<{ entity: string; project: string }, { runs: { edges: { node: RawRun }[] } | null }>(
    credentials,
    projects,
    25,
    (index) => `$e${index}: String!, $p${index}: String!`,
    (index) =>
      `project(name: $p${index}, entityName: $e${index}) { runs(first: ${RUNS_PER_PROJECT}, order: "-created_at", filters: $f) { edges { node { name displayName state createdAt heartbeatAt host group jobType summaryMetrics } } } }`,
    ({ entity, project }, index) => ({ [`e${index}`]: entity, [`p${index}`]: project }),
    { declarations: "$f: JSONString", variables: { f: filters } },
  );
  return projects.flatMap(({ entity, project }, index) =>
    (results[index]?.runs?.edges ?? []).map(({ node }) => ({ entity, project, raw: node })),
  );
}

/** Recent values of each run's headline metric, in one request. */
async function fetchRecent(credentials: Credentials, runs: WandbRun[]): Promise<void> {
  const wanted = runs.filter((run) => run.headline);
  if (wanted.length === 0) return;
  const results = await batched<WandbRun, { run: { sampledHistory: Record<string, unknown>[][] } | null }>(
    credentials,
    wanted,
    20,
    (index) => `$e${index}: String!, $p${index}: String!, $r${index}: String!, $s${index}: [JSONString!]!`,
    (index) => `project(name: $p${index}, entityName: $e${index}) { run(name: $r${index}) { sampledHistory(specs: $s${index}) } }`,
    (run, index) => ({
      [`e${index}`]: run.entity,
      [`p${index}`]: run.project,
      [`r${index}`]: run.id,
      [`s${index}`]: [JSON.stringify({ keys: ["_step", run.headline!.key], samples: SPARK_SAMPLES })],
    }),
  );
  wanted.forEach((run, index) => {
    const rows = results[index]?.run?.sampledHistory?.[0] ?? [];
    run.headline!.recent = rows
      .map((row) => [numberOrNull(row._step), numberOrNull(row[run.headline!.key])] as const)
      .filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null)
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => value);
  });
}

async function loadStatus(): Promise<WandbStatus> {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new WandbError("No W&B API key. Run `wandb login` on the daemon machine or set WANDB_API_KEY for the daemon.");
  }
  const viewer = await getViewer(credentials);
  const projects = await getProjects(credentials, viewer.entities);
  const app = appUrl(credentials.baseUrl);

  const runs: WandbRun[] = (await fetchRuns(credentials, projects)).map(({ entity, project, raw }) => {
    const summary = parseSummary(raw.summaryMetrics);
    const state = (raw.state ?? "unknown") as RunState;
    const headline = pickHeadline(summary);
    return {
      key: runKey(entity, project, raw.name),
      entity,
      project,
      id: raw.name,
      name: raw.displayName || raw.name,
      state: RUN_STATES.has(state) ? state : "unknown",
      createdAt: isoTime(raw.createdAt) ?? raw.createdAt,
      heartbeatAt: isoTime(raw.heartbeatAt),
      runtime: numberOrNull(summary._runtime) ?? numberOrNull(summary["_wandb.runtime"]),
      step: numberOrNull(summary._step),
      host: raw.host,
      group: raw.group,
      jobType: raw.jobType,
      url: `${app}/${encodeURIComponent(entity)}/${encodeURIComponent(project)}/runs/${encodeURIComponent(raw.name)}`,
      link: null,
      workspaceLabel: null,
      headline: headline ? { ...headline, recent: [] } : null,
    };
  });
  runs.sort(
    (a, b) =>
      Number(isActive(b)) - Number(isActive(a)) ||
      (parseTime(b.heartbeatAt) || parseTime(b.createdAt)) - (parseTime(a.heartbeatAt) || parseTime(a.createdAt)),
  );
  runs.splice(MAX_RUNS);

  const [links] = await Promise.all([
    linker.resolve(runs.map((run) => ({ ...run, createdAt: parseTime(run.createdAt) }))),
    fetchRecent(credentials, runs).catch((error) => console.error("Could not fetch recent values", error)),
  ]);
  for (const run of runs) run.link = links.get(run.key) ?? null;
  const labels = await workspaceLabels(runs.flatMap((run) => (run.link?.workspaceId ? [run.link.workspaceId] : [])));
  for (const run of runs) run.workspaceLabel = run.link?.workspaceId ? (labels.get(run.link.workspaceId) ?? null) : null;

  return { fetchedAt: new Date().toISOString(), user: viewer.username, appUrl: app, runs, error: null };
}

export async function getWandbStatus(
  { refresh }: RpcInput<typeof wandbStatusRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof wandbStatusRpc>> {
  paseo = context.paseo;
  if (!refresh && statusCache && Date.now() - statusCache.at < STATUS_CACHE_MS) return statusCache.status;
  inFlight ??= loadStatus()
    .then((status) => {
      statusCache = { at: Date.now(), status };
      return status;
    })
    .catch((error: unknown) => {
      if (!(error instanceof WandbError)) console.error("W&B status failed", error);
      const message = error instanceof Error ? error.message : String(error);
      const previous = statusCache?.status;
      // Keep showing the last good list; record the failure time so the next poll retries.
      const status: WandbStatus = {
        fetchedAt: previous?.fetchedAt ?? null,
        user: previous?.user ?? null,
        appUrl: previous?.appUrl ?? "https://wandb.ai",
        runs: previous?.runs ?? [],
        error: message,
      };
      statusCache = { at: Date.now(), status };
      return status;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function toSeries(key: string, xKey: string, xLabel: string, rows: Record<string, unknown>[], scaleX = 1): Series {
  const points = rows
    .map((row) => [numberOrNull(row[xKey]), numberOrNull(row[key])] as const)
    .filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null)
    .map(([x, y]) => [x * scaleX, y] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  return { key, xLabel, points };
}

/** GPU, CPU, and memory use from the run's system events. */
function systemSeries(events: string[]): Series[] {
  const rows = events
    .map((event) => {
      try {
        return JSON.parse(event) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((row): row is Record<string, unknown> => row !== null);
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row)) keys.add(key);
  const wanted = [...keys]
    .filter((key) => /^system\.gpu\.\d+\.(gpu|memoryAllocated|powerWatts)$/.test(key) || key === "system.cpu" || key === "system.memory_percent")
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const label = (key: string) =>
    key
      .replace(/^system\.gpu\.(\d+)\.gpu$/, "GPU $1 utilization (%)")
      .replace(/^system\.gpu\.(\d+)\.memoryAllocated$/, "GPU $1 memory (%)")
      .replace(/^system\.gpu\.(\d+)\.powerWatts$/, "GPU $1 power (W)")
      .replace(/^system\.cpu$/, "CPU (%)")
      .replace(/^system\.memory_percent$/, "System memory (%)");
  return wanted
    .map((key) => ({ ...toSeries(key, "_runtime", "minutes", rows, 1 / 60), key: label(key) }))
    .filter((series) => series.points.length > 0);
}

export async function getRunHistory({ entity, project, id }: RpcInput<typeof runHistoryRpc>): Promise<RpcOutput<typeof runHistoryRpc>> {
  const key = runKey(entity, project, id);
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.history;

  const credentials = await loadCredentials();
  if (!credentials) throw new Error("No W&B API key on the daemon machine.");
  const location = { e: entity, p: project, r: id };
  const keysData = await graphql<{ project: { run: { historyKeys: { keys?: Record<string, { typeCounts?: { type: string }[] }> } | null } | null } | null }>(
    credentials,
    "query($e: String!, $p: String!, $r: String!) { project(name: $p, entityName: $e) { run(name: $r) { historyKeys } } }",
    location,
  );
  const run = keysData.project?.run;
  if (!run) throw new Error(`W&B has no run ${key}.`);
  const numericKeys = Object.entries(run.historyKeys?.keys ?? {})
    .filter(([name, info]) => isChartKey(name) && info.typeCounts?.some((count) => count.type === "number"))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const chartKeys = numericKeys.slice(0, MAX_CHART_KEYS);

  const specs = chartKeys.map((name) => JSON.stringify({ keys: ["_step", name], samples: HISTORY_SAMPLES }));
  const data = await graphql<{ project: { run: { sampledHistory?: Record<string, unknown>[][]; events: string[] } | null } | null }>(
    credentials,
    `query($e: String!, $p: String!, $r: String!${specs.length ? ", $s: [JSONString!]!" : ""}) { project(name: $p, entityName: $e) { run(name: $r) { ${specs.length ? "sampledHistory(specs: $s)" : ""} events(samples: ${HISTORY_SAMPLES}) } } }`,
    specs.length ? { ...location, s: specs } : location,
  );
  const sampled = data.project?.run?.sampledHistory ?? [];
  const history: RunHistory = {
    fetchedAt: new Date().toISOString(),
    metrics: chartKeys.map((name, index) => toSeries(name, "_step", "step", sampled[index] ?? [])),
    system: systemSeries(data.project?.run?.events ?? []),
    omittedKeys: numericKeys.length - chartKeys.length,
  };
  historyCache.set(key, { at: Date.now(), history });
  // Drop finished lookups so the cache does not grow with every run ever opened.
  for (const [cachedKey, entry] of historyCache) {
    if (Date.now() - entry.at > 10 * 60_000) historyCache.delete(cachedKey);
  }
  return history;
}
