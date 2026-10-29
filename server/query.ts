/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  type FilterClause,
  parseRunKey,
  type projectsRpc,
  type RunSort,
  type runsByKeyRpc,
  type runsQueryRpc,
  type StateFilter,
  type WandbRun,
} from "../shared/wandb";
import { appUrl, batched, graphql, WandbError } from "./api";
import { RUN_DETAIL_FIELDS, type RawRun, toRun } from "./convert";
import { getProjects, getViewer, requireCredentials, savedLinks, useHandlerContext } from "./wandb";

const PAGE_SIZE = 50;

export async function listProjects(_input: RpcInput<typeof projectsRpc>, context: PluginHandlerContext): Promise<RpcOutput<typeof projectsRpc>> {
  useHandlerContext(context);
  const credentials = await requireCredentials();
  const viewer = await getViewer(credentials);
  return { projects: await getProjects(credentials, viewer.entities) };
}

/** W&B's run filters use MySQL REGEXP, which is already case-insensitive. */
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Numbers and booleans compare as such; anything else is text. */
function parseValue(text: string): string | number | boolean | null {
  const trimmed = text.trim();
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  if (trimmed === "null") return null;
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

/** The W&B filter path for a field the user typed. */
function filterField(field: string): string {
  if (field.startsWith("summary.")) return `summary_metrics.${field.slice(8)}`;
  if (field === "name") return "display_name";
  if (field.startsWith("config.") || ["group", "jobType", "host", "tags", "display_name", "state"].includes(field)) return field;
  throw new WandbError(`Cannot filter on "${field}". Use config.<key>, summary.<key>, name, group, jobType, host, or tags.`);
}

function clauseFilter({ field, op, value }: FilterClause): Record<string, unknown> {
  const path = filterField(field.trim());
  const parsed = parseValue(value);
  if (path === "tags") {
    if (op === "eq") return { tags: { $in: [value.trim()] } };
    if (op === "ne") return { tags: { $nin: [value.trim()] } };
    throw new WandbError("Tags only support = and ≠.");
  }
  // Config values logged as text, such as "1e-4", still match a number typed as one.
  const either = typeof parsed === "number" ? [parsed, value.trim()] : [parsed];
  switch (op) {
    case "eq":
      return { [path]: either.length > 1 ? { $in: either } : parsed };
    case "ne":
      return { [path]: either.length > 1 ? { $nin: either } : { $ne: parsed } };
    case "gt":
      return { [path]: { $gt: parsed } };
    case "gte":
      return { [path]: { $gte: parsed } };
    case "lt":
      return { [path]: { $lt: parsed } };
    case "lte":
      return { [path]: { $lte: parsed } };
    case "matches":
      return { [path]: { $regex: value.trim() } };
  }
}

const STATE_FILTERS: Record<Exclude<StateFilter, "all">, unknown> = {
  running: { $in: ["running", "pending"] },
  finished: "finished",
  failed: { $in: ["failed", "crashed"] },
  killed: { $in: ["killed", "preempted"] },
};

function buildFilters(search: string, state: StateFilter, clauses: FilterClause[]): Record<string, unknown> | null {
  const all: Record<string, unknown>[] = [];
  const text = search.trim();
  if (text) {
    const pattern = escapeRegex(text);
    all.push({ $or: ["display_name", "name", "group", "jobType"].map((field) => ({ [field]: { $regex: pattern } })) });
  }
  if (state !== "all") all.push({ state: STATE_FILTERS[state] });
  for (const clause of clauses) if (clause.field.trim()) all.push(clauseFilter(clause));
  return all.length ? { $and: all } : null;
}

function sortOrder({ key, desc }: RunSort): string {
  const field =
    key === "created"
      ? "created_at"
      : key === "heartbeat"
        ? "heartbeat_at"
        : key === "name"
          ? "display_name"
          : key === "runtime"
            ? "summary_metrics._runtime"
            : key.startsWith("summary.")
              ? `summary_metrics.${key.slice(8)}`
              : key.startsWith("config.")
                ? key
                : "created_at";
  return `${desc ? "-" : "+"}${field}`;
}

export async function queryRuns(input: RpcInput<typeof runsQueryRpc>, context: PluginHandlerContext): Promise<RpcOutput<typeof runsQueryRpc>> {
  useHandlerContext(context);
  const credentials = await requireCredentials();
  const filters = buildFilters(input.search, input.state, input.filters);
  const data = await graphql<{
    project: {
      runs: { totalCount: number | null; edges: { node: RawRun }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null;
    } | null;
  }>(
    credentials,
    `query($e: String!, $p: String!, $f: JSONString, $o: String, $after: String) { project(name: $p, entityName: $e) { runs(first: ${PAGE_SIZE}, filters: $f, order: $o, after: $after) { totalCount edges { node { ${RUN_DETAIL_FIELDS} } } pageInfo { hasNextPage endCursor } } } }`,
    {
      e: input.entity,
      p: input.project,
      f: filters ? JSON.stringify(filters) : null,
      o: sortOrder(input.sort),
      after: input.cursor,
    },
  );
  const page = data.project?.runs;
  if (!data.project) throw new WandbError(`W&B has no project ${input.entity}/${input.project}.`);
  const app = appUrl(credentials.baseUrl);
  const runs = (page?.edges ?? []).map(({ node }) => toRun(input.entity, input.project, node, app, true));
  await savedLinks(runs);
  return {
    runs,
    total: page?.totalCount ?? null,
    cursor: page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
  };
}

/** Full rows for runs picked for comparison, which may span projects. */
export async function runsByKey({ keys }: RpcInput<typeof runsByKeyRpc>, context: PluginHandlerContext): Promise<RpcOutput<typeof runsByKeyRpc>> {
  useHandlerContext(context);
  const credentials = await requireCredentials();
  const wanted = [...new Set(keys)].map(parseRunKey).filter((key): key is NonNullable<typeof key> => key !== null);
  const results = await batched<(typeof wanted)[number], { run: RawRun | null }>(
    credentials,
    wanted,
    20,
    (index) => `$e${index}: String!, $p${index}: String!, $r${index}: String!`,
    (index) => `project(name: $p${index}, entityName: $e${index}) { run(name: $r${index}) { ${RUN_DETAIL_FIELDS} } }`,
    (key, index) => ({ [`e${index}`]: key.entity, [`p${index}`]: key.project, [`r${index}`]: key.id }),
  );
  const app = appUrl(credentials.baseUrl);
  const runs: WandbRun[] = [];
  wanted.forEach((key, index) => {
    const raw = results[index]?.run;
    if (raw) runs.push(toRun(key.entity, key.project, raw, app, true));
  });
  await savedLinks(runs);
  return { runs };
}
