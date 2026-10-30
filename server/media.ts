/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { type MediaEntry, type MediaItem, type MediaKind, type mediaFileRpc, type mediaIndexRpc, runKey, type TableCell } from "../shared/wandb";
import { graphql, WandbError } from "./api";
import { numberOrNull, parseObject } from "./convert";
import { requireCredentials } from "./wandb";

/** W&B media types this plugin recognizes, by the `_type` it logs. */
const MEDIA_TYPES: Record<string, MediaKind> = {
  "image-file": "images",
  "images/separated": "images",
  "table-file": "table",
  "joined-table": "table",
  "partitioned-table": "table",
  histogram: "histogram",
  "video-file": "video",
  "audio-file": "audio",
  "html-file": "html",
  "object3D-file": "other",
  "molecule-file": "other",
  "plotly-file": "other",
  "bokeh-file": "other",
};
const MAX_KEYS = 40;
const SAMPLES_PER_KEY = 60;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TABLE_BYTES = 10 * 1024 * 1024;
const MAX_TABLE_ROWS = 2_000;
const INDEX_CACHE_MS = 15_000;

const indexCache = new Map<string, { at: number; index: RpcOutput<typeof mediaIndexRpc> }>();

type Raw = Record<string, unknown>;

const strings = (value: unknown) => (Array.isArray(value) ? value.map((item) => (typeof item === "string" ? item : null)) : []);

/** A histogram's bins and counts, from explicit bins or W&B's packed form (min, bin size, count). */
function histogramOf(value: Raw): MediaEntry["histogram"] {
  const values = Array.isArray(value.values) ? value.values.map(Number) : [];
  if (Array.isArray(value.bins)) return { bins: value.bins.map(Number), values };
  const packed = value.packedBins as { min?: number; size?: number; count?: number } | undefined;
  if (packed && typeof packed.min === "number" && typeof packed.size === "number") {
    const count = packed.count ?? values.length;
    return { bins: Array.from({ length: count + 1 }, (_, index) => packed.min! + index * packed.size!), values };
  }
  return null;
}

function entryOf(step: number | null, value: unknown): MediaEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Raw;
  const filenames = strings(raw.filenames).filter((name): name is string => name !== null);
  const files = filenames.length ? filenames : typeof raw.path === "string" ? [raw.path] : [];
  const captions = Array.isArray(raw.captions) ? strings(raw.captions) : typeof raw.caption === "string" ? [raw.caption] : [];
  return {
    step,
    files,
    captions,
    width: numberOrNull(raw.width),
    height: numberOrNull(raw.height),
    rows: numberOrNull(raw.nrows),
    cols: numberOrNull(raw.ncols),
    histogram: raw._type === "histogram" ? histogramOf(raw) : null,
  };
}

/** Media keys of a run with every logged value, and its custom charts (wandb.plot.*) with their tables. */
export async function getMediaIndex({ entity, project, id }: RpcInput<typeof mediaIndexRpc>): Promise<RpcOutput<typeof mediaIndexRpc>> {
  const key = runKey(entity, project, id);
  const cached = indexCache.get(key);
  if (cached && Date.now() - cached.at < INDEX_CACHE_MS) return cached.index;
  const credentials = await requireCredentials();
  const location = { e: entity, p: project, r: id };
  const data = await graphql<{ project: { run: { historyKeys: { keys?: Record<string, { typeCounts?: { type: string }[] }> } | null; summaryMetrics: string | null; config: string | null } | null } | null }>(
    credentials,
    "query($e: String!, $p: String!, $r: String!) { project(name: $p, entityName: $e) { run(name: $r) { historyKeys summaryMetrics config } } }",
    location,
  );
  const run = data.project?.run;
  if (!run) throw new WandbError(`W&B has no run ${key}.`);
  const summary = parseObject(run.summaryMetrics);
  const types = new Map<string, string>();
  for (const [name, info] of Object.entries(run.historyKeys?.keys ?? {})) {
    const type = info.typeCounts?.map((count) => count.type).find((candidate) => candidate in MEDIA_TYPES);
    if (type) types.set(name, type);
  }
  // Media set only on the summary has no history.
  for (const [name, value] of Object.entries(summary)) {
    const type = value && typeof value === "object" ? (value as Raw)._type : undefined;
    if (typeof type === "string" && type in MEDIA_TYPES && !types.has(name)) types.set(name, type);
  }
  // Custom charts store a preset and field mapping in the config and log their data as `<key>_table`.
  const wandbConfig = parseObject(JSON.stringify((parseObject(run.config)._wandb as Raw | undefined)?.value ?? {}));
  const visualize = (wandbConfig.visualize ?? {}) as Record<string, { panel_config?: { panelDefId?: string; fieldSettings?: Record<string, string>; stringSettings?: { title?: string } } }>;
  const charts = new Map<string, { chartKey: string; spec: NonNullable<(typeof visualize)[string]["panel_config"]> }>();
  for (const [chartKey, spec] of Object.entries(visualize)) {
    if (types.has(`${chartKey}_table`)) charts.set(`${chartKey}_table`, { chartKey, spec: spec.panel_config ?? {} });
  }

  const keys = [...types.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const shown = keys.slice(0, MAX_KEYS);
  const specs = shown.map((name) => JSON.stringify({ keys: ["_step", name], samples: SAMPLES_PER_KEY }));
  const history = specs.length
    ? await graphql<{ project: { run: { sampledHistory: Raw[][] | null } | null } | null }>(
        credentials,
        "query($e: String!, $p: String!, $r: String!, $s: [JSONString!]!) { project(name: $p, entityName: $e) { run(name: $r) { sampledHistory(specs: $s) } } }",
        { ...location, s: specs },
      )
    : null;
  const sampled = history?.project?.run?.sampledHistory ?? [];

  const items: MediaItem[] = shown.map((name, index) => {
    const rows = sampled[index] ?? [];
    let entries = rows
      .map((row) => entryOf(numberOrNull(row._step), row[name]))
      .filter((entry): entry is MediaEntry => entry !== null && (entry.files.length > 0 || entry.histogram !== null))
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0));
    if (entries.length === 0) {
      const latest = entryOf(null, summary[name]);
      entries = latest ? [latest] : [];
    }
    const chart = charts.get(name);
    if (chart) {
      return {
        key: chart.chartKey,
        kind: "chart" as const,
        type: chart.spec.panelDefId ?? "custom",
        entries,
        chart: { title: chart.spec.stringSettings?.title ?? null, fields: chart.spec.fieldSettings ?? {} },
      };
    }
    const type = types.get(name)!;
    return { key: name, kind: MEDIA_TYPES[type], type, entries, chart: null };
  });
  const index = { items: items.filter((item) => item.entries.length > 0), omitted: keys.length - shown.length };
  indexCache.set(key, { at: Date.now(), index });
  for (const [cachedKey, entry] of indexCache) {
    if (Date.now() - entry.at > 5 * 60_000) indexCache.delete(cachedKey);
  }
  return index;
}

/** A table cell for the app: plain values as they are, images as references, other media by type. */
function cellOf(value: unknown): TableCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const raw = value as Raw;
    if (raw._type === "image-file" && typeof raw.path === "string") return { image: raw.path };
    if (typeof raw._type === "string") return `[${raw._type}]`;
  }
  const text = JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Fetches one of the run's files through W&B's signed storage link, within size limits. */
export async function getMediaFile({ entity, project, id, path }: RpcInput<typeof mediaFileRpc>): Promise<RpcOutput<typeof mediaFileRpc>> {
  try {
    const credentials = await requireCredentials();
    const data = await graphql<{ project: { run: { files: { edges: { node: { directUrl: string | null; sizeBytes: number | null; mimetype: string | null } }[] } | null } | null } | null }>(
      credentials,
      "query($e: String!, $p: String!, $r: String!, $n: [String!]) { project(name: $p, entityName: $e) { run(name: $r) { files(names: $n, first: 1) { edges { node { directUrl sizeBytes mimetype } } } } } }",
      { e: entity, p: project, r: id, n: [path] },
    );
    const file = data.project?.run?.files?.edges[0]?.node;
    if (!file?.directUrl) return { kind: "unavailable", reason: "W&B has no such file for this run." };
    const isTable = path.endsWith(".table.json") || path.endsWith(".json");
    const limit = isTable ? MAX_TABLE_BYTES : MAX_IMAGE_BYTES;
    if ((file.sizeBytes ?? 0) > limit) return { kind: "unavailable", reason: `The file is ${Math.round((file.sizeBytes ?? 0) / 1048576)} MB; open it in W&B.` };
    const response = await fetch(file.directUrl, { signal: AbortSignal.timeout(30_000) as RequestInit["signal"] });
    // W&B signs a link for any name; storage answers 403 or 404 when the file was never uploaded.
    if (response.status === 403 || response.status === 404) return { kind: "unavailable", reason: "W&B has no such file for this run." };
    if (!response.ok) return { kind: "unavailable", reason: `Storage returned HTTP ${response.status}.` };
    const bytes = Buffer.from(await response.arrayBuffer());
    if (isTable) {
      const table = JSON.parse(bytes.toString("utf8")) as { columns?: unknown[]; data?: unknown[][] };
      const columns = (table.columns ?? []).map(String);
      const rows = (table.data ?? []).slice(0, MAX_TABLE_ROWS).map((row) => (Array.isArray(row) ? row.map(cellOf) : []));
      return { kind: "table", columns, rows, total: table.data?.length ?? rows.length };
    }
    const mime = file.mimetype?.startsWith("image/") ? file.mimetype : `image/${path.split(".").pop()?.toLowerCase() === "jpg" ? "jpeg" : (path.split(".").pop()?.toLowerCase() ?? "png")}`;
    return { kind: "image", uri: `data:${mime};base64,${bytes.toString("base64")}` };
  } catch (error) {
    return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
