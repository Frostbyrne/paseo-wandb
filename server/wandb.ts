/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  isActive,
  isLive,
  type Logger,
  runKey,
  type RunHistory,
  type Series,
  type WandbProject,
  type WandbRun,
  type WandbStatus,
  type runHistoryRpc,
  type wandbStatusRpc,
} from "../shared/wandb";
import { appUrl, batched, type Credentials, graphql, loadCredentials, WandbError } from "./api";
import { isChartKey, numberOrNull, parseTime, RUN_FIELDS, type RawRun, toRun } from "./convert";
import { RunLinker } from "./links";

// Every open surface polls; this keeps several windows and hosts to one round of W&B calls.
const STATUS_CACHE_MS = 15_000;
const HISTORY_CACHE_MS = 15_000;
const VIEWER_CACHE_MS = 10 * 60_000;
// Short, so a project an agent just created shows its runs within a minute.
const PROJECTS_CACHE_MS = 60_000;
/** Ended runs stay listed this long after their last heartbeat. */
const RECENT_MS = 6 * 3600_000;
const MAX_RUNS = 60;
const RUNS_PER_PROJECT = 50;
const SPARK_SAMPLES = 40;
const HISTORY_SAMPLES = 300;
const MAX_CHART_KEYS = 48;

interface Viewer {
  username: string;
  entities: string[];
}

const linker = new RunLinker();
let viewerCache: { at: number; baseUrl: string; viewer: Viewer } | null = null;
let projectsCache: { at: number; baseUrl: string; projects: WandbProject[] } | null = null;
let statusCache: { at: number; status: WandbStatus } | null = null;
let inFlight: Promise<WandbStatus> | null = null;
const historyCache = new Map<string, { at: number; history: RunHistory }>();
const labelCache = new Map<string, { at: number; label: string | null }>();
let paseo: PluginHandlerContext["paseo"] | null = null;

export async function getViewer(credentials: Credentials): Promise<Viewer> {
  if (viewerCache && viewerCache.baseUrl === credentials.baseUrl && Date.now() - viewerCache.at < VIEWER_CACHE_MS) {
    return viewerCache.viewer;
  }
  const data = await graphql<{
    viewer: { username: string; entity: string; teams: { edges: { node: { name: string } }[] } | null } | null;
  }>(credentials, "{ viewer { username entity teams { edges { node { name } } } } }");
  if (!data.viewer) throw new WandbError("W&B did not return the account for this API key.");
  // The default entity can be a team, so the username's personal entity is listed too.
  const entities = [data.viewer.entity, data.viewer.username, ...(data.viewer.teams?.edges.map((edge) => edge.node.name) ?? [])];
  const viewer = { username: data.viewer.username, entities: [...new Set(entities.filter(Boolean))] };
  viewerCache = { at: Date.now(), baseUrl: credentials.baseUrl, viewer };
  return viewer;
}

/** Every project of the viewer's entities, most recently active first. */
export async function getProjects(credentials: Credentials, entities: string[]): Promise<WandbProject[]> {
  if (projectsCache && projectsCache.baseUrl === credentials.baseUrl && Date.now() - projectsCache.at < PROJECTS_CACHE_MS) {
    return projectsCache.projects;
  }
  const results = await batched<string, { edges: { node: { name: string; runCount: number | null; lastActive: string | null } }[] }>(
    credentials,
    entities,
    10,
    (index) => `$e${index}: String!`,
    // The 100 most recently active projects of each entity; older ones rarely hold live runs.
    (index) => `projects(entityName: $e${index}, first: 100, order: "-lastActive") { edges { node { name runCount lastActive } } }`,
    (entity, index) => ({ [`e${index}`]: entity }),
  );
  const projects = entities
    .flatMap((entity, index) =>
      (results[index]?.edges ?? []).map(({ node }) => ({
        entity,
        project: node.name,
        runCount: node.runCount ?? null,
        lastActive: node.lastActive && Number.isFinite(parseTime(node.lastActive)) ? new Date(parseTime(node.lastActive)).toISOString() : null,
      })),
    )
    .sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? ""));
  projectsCache = { at: Date.now(), baseUrl: credentials.baseUrl, projects };
  return projects;
}

/** The daemon's credentials, or the error every handler reports without them. */
export async function requireCredentials(): Promise<Credentials> {
  const credentials = await loadCredentials();
  if (!credentials) {
    throw new WandbError("No W&B API key. Run `wandb login` on the daemon machine or set WANDB_API_KEY for the daemon.");
  }
  return credentials;
}

/** Remembers the daemon session from any handler, for workspace lookups. */
export function useHandlerContext(context: PluginHandlerContext) {
  paseo = context.paseo;
}

/** `project › workspace` labels for the linked workspaces; null for ones the daemon no longer has. */
export async function workspaceLabels(ids: string[]): Promise<Map<string, string | null>> {
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
      `project(name: $p${index}, entityName: $e${index}) { runs(first: ${RUNS_PER_PROJECT}, order: "-created_at", filters: $f) { edges { node { ${RUN_FIELDS} } } } }`,
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
  const credentials = await requireCredentials();
  const viewer = await getViewer(credentials);
  const projects = await getProjects(credentials, viewer.entities);
  const app = appUrl(credentials.baseUrl);

  const runs: WandbRun[] = (await fetchRuns(credentials, projects)).map(({ entity, project, raw }) => toRun(entity, project, raw, app, false));
  runs.sort(
    (a, b) =>
      Number(isActive(b)) - Number(isActive(a)) ||
      Number(b.updating) - Number(a.updating) ||
      (parseTime(b.heartbeatAt) || parseTime(b.createdAt)) - (parseTime(a.heartbeatAt) || parseTime(a.createdAt)),
  );
  runs.splice(MAX_RUNS);

  const [{ links, loggers: found }] = await Promise.all([
    linker.resolve(runs.map((run) => ({ ...run, createdAt: parseTime(run.createdAt) }))),
    fetchRecent(credentials, runs.filter(isLive)).catch((error) => console.error("Could not fetch recent values", error)),
  ]);
  for (const run of runs) run.link = links.get(run.key) ?? null;
  // A run that a still-running local script created or reopened can still be added to, however
  // long the script waits between results, though W&B shows it finished. Scripts that finish exit.
  const fromLoggers = new Set(found.flatMap((logger) => logger.runIds));
  for (const run of runs) if (!isActive(run) && fromLoggers.has(run.id)) run.updating = true;
  // Paseo agents mark their processes with the agent, not the workspace; the agent knows both.
  const agents = await agentInfo([
    ...runs.flatMap((run) => (run.link?.agentId ? [run.link.agentId] : [])),
    ...found.flatMap((logger) => (logger.env.agentId ? [logger.env.agentId] : [])),
  ]);
  for (const run of runs) {
    const agent = run.link?.agentId ? agents.get(run.link.agentId) : undefined;
    if (run.link && agent) run.link = { ...run.link, workspaceId: run.link.workspaceId ?? agent.workspaceId, agentName: run.link.agentName ?? agent.title };
  }
  for (const logger of found) {
    const agent = logger.env.agentId ? agents.get(logger.env.agentId) : undefined;
    if (agent) {
      logger.env = { ...logger.env, workspaceId: logger.env.workspaceId ?? agent.workspaceId };
      logger.agentName ??= agent.title;
    }
  }
  runs.sort((a, b) => Number(isLive(b)) - Number(isLive(a)));
  await labelRuns(runs);
  const labels = await workspaceLabels(found.flatMap((logger) => (logger.env.workspaceId ? [logger.env.workspaceId] : [])));
  const loggers: Logger[] = found.map((logger) => ({
    pid: logger.pid,
    command: logger.command,
    processCount: logger.processCount,
    workspaceId: logger.env.workspaceId,
    workspaceLabel: logger.env.workspaceId ? (labels.get(logger.env.workspaceId) ?? null) : null,
    agentName: logger.agentName,
    startedAt: new Date(logger.startedAt).toISOString(),
    lastLogAt: logger.lastLogAt ? new Date(logger.lastLogAt).toISOString() : null,
    runKeys: runs.filter((run) => logger.runIds.includes(run.id)).map((run) => run.key),
    runCount: logger.runIds.length,
  }));

  return { fetchedAt: new Date().toISOString(), user: viewer.username, appUrl: app, runs, loggers, error: null };
}

const agentCache = new Map<string, { at: number; info: { workspaceId: string | null; title: string | null } | null }>();

/** Workspace and title of Paseo agents, for runs their processes started. */
async function agentInfo(ids: string[]): Promise<Map<string, { workspaceId: string | null; title: string | null }>> {
  const result = new Map<string, { workspaceId: string | null; title: string | null }>();
  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const cached = agentCache.get(id);
      if (cached && Date.now() - cached.at < 60_000) {
        if (cached.info) result.set(id, cached.info);
        return;
      }
      if (!paseo) return;
      try {
        const handle = paseo.agents.ref(id);
        await handle.refresh();
        const agent = handle.current();
        const info = agent ? { workspaceId: agent.workspaceId ?? null, title: agent.title ?? null } : null;
        agentCache.set(id, { at: Date.now(), info });
        if (info) result.set(id, info);
      } catch (error) {
        console.error("Could not look up agent", id, error);
        agentCache.set(id, { at: Date.now(), info: null });
      }
    }),
  );
  return result;
}

/** Makes the next status call refetch, after an action changed a run. */
export function forgetStatus() {
  statusCache = null;
}

/** Fills `workspaceLabel` for runs that have a linked workspace. */
export async function labelRuns(runs: WandbRun[]): Promise<void> {
  const labels = await workspaceLabels(runs.flatMap((run) => (run.link?.workspaceId ? [run.link.workspaceId] : [])));
  for (const run of runs) run.workspaceLabel = run.link?.workspaceId ? (labels.get(run.link.workspaceId) ?? null) : null;
}

/** Saved links for runs from queries, without scanning processes or transcripts. */
export async function savedLinks(runs: WandbRun[]): Promise<void> {
  const links = await linker.lookup(runs.map((run) => run.key));
  for (const run of runs) run.link = links.get(run.key) ?? null;
  await labelRuns(runs);
}

export async function getWandbStatus(
  { refresh }: RpcInput<typeof wandbStatusRpc>,
  context: PluginHandlerContext,
): Promise<RpcOutput<typeof wandbStatusRpc>> {
  useHandlerContext(context);
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
        loggers: previous?.loggers ?? [],
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

type HistoryRow = Record<string, unknown>;

function toSeries(key: string, valueKey: string, rows: HistoryRow[], withStep: boolean): Series {
  const points = rows
    .map((row) => [withStep ? numberOrNull(row._step) : null, numberOrNull(row._runtime), numberOrNull(row._timestamp), numberOrNull(row[valueKey])] as const)
    .filter((point): point is readonly [number | null, number | null, number | null, number] => point[3] !== null && (point[0] ?? point[1] ?? point[2]) !== null)
    .map((point) => [...point] as [number | null, number | null, number | null, number])
    .sort((a, b) => (a[0] ?? a[1] ?? a[2] ?? 0) - (b[0] ?? b[1] ?? b[2] ?? 0));
  return { key, points };
}

/** GPU, CPU, and memory use from the run's system events. */
function systemSeries(events: string[]): Series[] {
  const rows = events
    .map((event) => {
      try {
        return JSON.parse(event) as HistoryRow;
      } catch {
        return null;
      }
    })
    .filter((row): row is HistoryRow => row !== null);
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
  return wanted.map((key) => toSeries(label(key), key, rows, false)).filter((series) => series.points.length > 0);
}

export async function getRunHistory({ entity, project, id }: RpcInput<typeof runHistoryRpc>): Promise<RpcOutput<typeof runHistoryRpc>> {
  const key = runKey(entity, project, id);
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) return cached.history;

  const credentials = await requireCredentials();
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

  // Runtime and wall time ride along so the client can switch the x axis without refetching.
  const specs = chartKeys.map((name) => JSON.stringify({ keys: ["_step", "_runtime", "_timestamp", name], samples: HISTORY_SAMPLES }));
  const data = await graphql<{ project: { run: { sampledHistory?: HistoryRow[][]; events: string[] } | null } | null }>(
    credentials,
    `query($e: String!, $p: String!, $r: String!${specs.length ? ", $s: [JSONString!]!" : ""}) { project(name: $p, entityName: $e) { run(name: $r) { ${specs.length ? "sampledHistory(specs: $s)" : ""} events(samples: ${HISTORY_SAMPLES}) } } }`,
    specs.length ? { ...location, s: specs } : location,
  );
  const sampled = data.project?.run?.sampledHistory ?? [];
  const history: RunHistory = {
    fetchedAt: new Date().toISOString(),
    metrics: chartKeys.map((name, index) => toSeries(name, name, sampled[index] ?? [], true)),
    system: systemSeries(data.project?.run?.events ?? []),
    omittedKeys: numericKeys.length - chartKeys.length,
  };
  historyCache.set(key, { at: Date.now(), history });
  // Drop stale entries so the cache does not grow with every run ever opened.
  for (const [cachedKey, entry] of historyCache) {
    if (Date.now() - entry.at > 10 * 60_000) historyCache.delete(cachedKey);
  }
  return history;
}
