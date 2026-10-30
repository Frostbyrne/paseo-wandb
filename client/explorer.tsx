import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useQueries } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isActive, isLive, type RunHistory, runHistoryRpc, type Series, type WandbRun } from "../shared/wandb";
import { ChartCard, type ChartLine, ChartGrid } from "./chart";
import { CompareTable } from "./compare";
import { Chip, Field, LineKey, Segmented, Slider, Toggle } from "./controls";
import { type ChartPrefs, type Dash, runLabels, type Selection, seriesColor, seriesDash } from "./model";
import { HealthBadges, LiveLine, LogsView, StopButton } from "./live";
import { MediaPane } from "./media";
import { aggregate, extent, metricMatcher, smooth, toLog, toXY, type XY } from "./series";
import { formatValue, stateColor, stateText, useNow } from "./state";

const CHARTS_PER_SECTION = 6;
const LIVE_ROWS = 4;
const POLL_MS = 15_000;
const STEP_WINDOWS = [100, 1_000, 10_000, 100_000];
const TIME_WINDOWS = [300, 900, 3_600, 21_600];

/** What one legend entry and one set of lines stand for: a run, or a group of runs. */
interface Entity {
  id: string;
  label: string;
  color: string;
  dash: Dash;
  runKeys: string[];
}

function groupValue(run: WandbRun, groupBy: string): string {
  const value = groupBy === "group" ? run.group : groupBy === "jobType" ? run.jobType : run.config?.[groupBy.slice(7)];
  return value === null || value === undefined || value === "" ? "none" : String(value);
}

/** Config keys whose values differ across the runs, the useful ones to group by. */
function differingConfigKeys(runs: WandbRun[]): string[] {
  if (runs.length < 2) return [];
  const keys = new Set<string>();
  for (const run of runs) for (const key of Object.keys(run.config ?? {})) keys.add(key);
  return [...keys]
    .filter((key) => new Set(runs.map((run) => JSON.stringify(run.config?.[key] ?? null))).size > 1)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, 8);
}

function useHistories(runs: WandbRun[]) {
  const fetchHistory = useRpc(runHistoryRpc);
  const results = useQueries({
    queries: runs.map((run) => ({
      queryKey: ["wandb-history", run.key],
      queryFn: () => fetchHistory({ entity: run.entity, project: run.project, id: run.id }),
      refetchInterval: isLive(run) ? POLL_MS : (false as const),
      staleTime: isLive(run) ? 0 : Infinity,
      retry: 1,
    })),
  });
  // Rebuilt only when a history changes, so charts do not recompute on unrelated renders.
  const stamp = results.map((result, index) => `${runs[index].key}@${result.dataUpdatedAt}`).join("|");
  const histories = useMemo(() => {
    const map = new Map<string, RunHistory>();
    results.forEach((result, index) => {
      if (result.data) map.set(runs[index].key, result.data);
    });
    return map;
  }, [stamp]);
  return {
    histories,
    pending: results.filter((result) => result.isPending).length,
    errors: results.flatMap((result, index) => (result.error ? [`${runs[index].name}: ${result.error.message}`] : [])),
  };
}

function seriesFor(history: RunHistory | undefined, key: string, system: boolean): Series | undefined {
  return (system ? history?.system : history?.metrics)?.find((series) => series.key === key);
}

function chartLines(
  key: string,
  system: boolean,
  entities: Entity[],
  histories: Map<string, RunHistory>,
  prefs: ChartPrefs,
  windowStart: number | null,
  highlight: string | null,
): ChartLine[] {
  const lines: ChartLine[] = [];
  const inWindow = (points: XY[]) => (windowStart === null ? points : points.filter((point) => point.x >= windowStart));
  // Faint raw lines under smoothed ones help with a few runs and only add clutter beyond that.
  const showRaw = prefs.smoothing > 0 && entities.length <= 3;
  for (const entity of entities) {
    const style = { color: entity.color, dash: entity.dash, dim: highlight !== null && entity.id !== highlight };
    const members = entity.runKeys.map((runKey) => {
      const series = seriesFor(histories.get(runKey), key, system);
      const points = series ? inWindow(toXY(series.points, prefs.xAxis)) : [];
      return prefs.logY ? toLog(points) : points;
    });
    if (entity.runKeys.length === 1) {
      const raw = members[0];
      if (raw.length === 0) continue;
      if (showRaw) lines.push({ id: `${entity.id}:raw`, label: entity.label, ...style, points: raw, faint: true });
      lines.push({ id: entity.id, label: entity.label, ...style, points: smooth(raw, prefs.smoothing) });
    } else {
      const { mean, min, max } = aggregate(members);
      if (mean.length === 0) continue;
      const smoothed = (points: XY[]) => smooth(points, prefs.smoothing);
      lines.push({ id: `${entity.id}:min`, label: `${entity.label} min`, ...style, points: smoothed(min), faint: true });
      lines.push({ id: `${entity.id}:max`, label: `${entity.label} max`, ...style, points: smoothed(max), faint: true });
      lines.push({ id: entity.id, label: `${entity.label} mean`, ...style, points: smoothed(mean) });
    }
  }
  return lines;
}

function MetricChart(props: {
  theme: PluginTheme;
  metric: string;
  system: boolean;
  entities: Entity[];
  histories: Map<string, RunHistory>;
  prefs: ChartPrefs;
  windowStart: number | null;
  highlight: string | null;
  width: number;
}) {
  const { theme, metric, system, entities, histories, prefs, width, highlight } = props;
  // System metrics have no steps, so a step window does not apply to them.
  const windowStart = system && prefs.xAxis === "step" ? null : props.windowStart;
  const lines = useMemo(
    () => chartLines(metric, system, entities, histories, prefs, windowStart, highlight),
    [metric, system, entities, histories, prefs, windowStart, highlight],
  );
  // More lines get fewer segments each, so many-run charts stay quick to draw.
  const divisor = entities.length <= 2 ? 4 : entities.length <= 4 ? 6 : entities.length <= 8 ? 8 : 12;
  return (
    <ChartCard
      theme={theme}
      title={metric}
      lines={lines}
      width={width}
      xAxis={system && prefs.xAxis === "step" ? "runtime" : prefs.xAxis}
      logY={prefs.logY}
      ignoreOutliers={prefs.ignoreOutliers}
      segmentsPerLine={Math.ceil(width / divisor)}
    />
  );
}

function Section(props: {
  theme: PluginTheme;
  title: string;
  metrics: string[];
  system: boolean;
  entities: Entity[];
  histories: Map<string, RunHistory>;
  prefs: ChartPrefs;
  windowStart: number | null;
  highlight: string | null;
  compact: boolean;
}) {
  const { theme, title, metrics, compact } = props;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? metrics : metrics.slice(0, CHARTS_PER_SECTION);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>{title}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{metrics.length}</Text>
      </View>
      <ChartGrid compact={compact}>
        {(width) => shown.map((metric) => <MetricChart key={metric} {...props} metric={metric} width={width} />)}
      </ChartGrid>
      {metrics.length > CHARTS_PER_SECTION ? (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>
            {expanded ? "Show fewer" : `Show all ${metrics.length}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Groups keys like W&B does: by the part before the first slash, ungrouped keys first. */
function sections(keys: string[]): { title: string; keys: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const slash = key.indexOf("/");
    const title = slash > 0 ? key.slice(0, slash) : "";
    groups.set(title, [...(groups.get(title) ?? []), key]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([title, sectionKeys]) => ({ title: title || "Charts", keys: sectionKeys }));
}

const windowLabel = (size: number, axis: ChartPrefs["xAxis"]) =>
  axis === "step" ? `last ${formatValue(size)}` : `last ${size >= 3_600 ? `${size / 3_600}h` : `${size / 60}m`}`;

function Charts({
  theme,
  compact,
  runs,
  entities,
  prefs,
  onPrefs,
  highlight,
}: {
  theme: PluginTheme;
  compact: boolean;
  runs: WandbRun[];
  entities: Entity[];
  prefs: ChartPrefs;
  onPrefs: (prefs: ChartPrefs) => void;
  highlight: string | null;
}) {
  const { histories, pending, errors } = useHistories(runs);
  // The window ends at the newest point of any run, so every chart shows the same stretch and follows new data.
  const span = useMemo(() => {
    const xs: number[] = [];
    for (const history of histories.values()) {
      for (const series of history.metrics) {
        const points = toXY(series.points, prefs.xAxis);
        if (points.length) xs.push(points[0].x, points[points.length - 1].x);
      }
    }
    return extent(xs);
  }, [histories, prefs.xAxis]);
  const windows = (prefs.xAxis === "step" ? STEP_WINDOWS : TIME_WINDOWS).filter((size) => span && size < span.max - span.min);
  const windowStart = prefs.window !== null && span ? span.max - prefs.window : null;
  const matches = metricMatcher(prefs.search);
  const metricKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const history of histories.values()) for (const series of history.metrics) keys.add(series.key);
    return [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [histories]);
  const systemKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const history of histories.values()) for (const series of history.system) keys.add(series.key);
    return [...keys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [histories]);
  const omitted = Math.max(0, ...[...histories.values()].map((history) => history.omittedKeys));
  const shownMetrics = metricKeys.filter(matches);
  const shownSystem = systemKeys.filter(matches);
  const common = { theme, entities, histories, prefs, windowStart, highlight, compact };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <View style={{ gap: 18 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <Text style={muted}>Show</Text>
        <Chip theme={theme} label="All" selected={prefs.window === null} onPress={() => onPrefs({ ...prefs, window: null })} />
        {windows.map((size) => (
          <Chip key={size} theme={theme} label={windowLabel(size, prefs.xAxis)} selected={prefs.window === size} onPress={() => onPrefs({ ...prefs, window: size })} />
        ))}
        <Toggle theme={theme} label="Ignore outliers" value={prefs.ignoreOutliers} onChange={(ignoreOutliers) => onPrefs({ ...prefs, ignoreOutliers })} />
      </View>
      {pending > 0 ? <Text style={muted}>Loading charts for {pending} {pending === 1 ? "run" : "runs"}…</Text> : null}
      {errors.map((error) => (
        <Text key={error} style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
          Could not load {error}
        </Text>
      ))}
      {pending === 0 && metricKeys.length === 0 && systemKeys.length === 0 ? <Text style={muted}>No metrics logged yet.</Text> : null}
      {metricKeys.length > 0 && shownMetrics.length === 0 && shownSystem.length === 0 ? <Text style={muted}>No metrics match “{prefs.search}”.</Text> : null}
      {sections(shownMetrics).map((section) => (
        <Section key={section.title} {...common} title={section.title} metrics={section.keys} system={false} />
      ))}
      {omitted > 0 ? <Text style={muted}>Up to {omitted} more metrics per run are not charted here; open the run in W&B for all of them.</Text> : null}
      {shownSystem.length > 0 ? <Section {...common} title="System" metrics={shownSystem} system /> : null}
    </View>
  );
}

/** Progress, rate, GPU use, and problems for each picked run that is still live, with Stop and Logs. */
function LiveStrip({
  theme,
  runs,
  labels,
  colors,
  dashes,
  onLogs,
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  labels: Map<string, string>;
  colors: Map<string, string>;
  dashes: Map<string, Dash>;
  onLogs: (key: string) => void;
}) {
  const now = useNow(15_000);
  const [expanded, setExpanded] = useState(false);
  // Running runs first; past a few rows the strip folds so the charts stay in view.
  const all = runs.filter(isLive).sort((a, b) => Number(isActive(b)) - Number(isActive(a)));
  const live = expanded ? all : all.slice(0, LIVE_ROWS);
  if (all.length === 0) return null;
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      {live.map((run) => (
        <View key={run.key} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <LineKey color={colors.get(run.key) ?? theme.colors.foregroundMuted} dash={dashes.get(run.key)} />
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
              {labels.get(run.key) ?? run.name}
            </Text>
            <Text style={{ color: stateColor(run, theme, now), fontSize: 11 }}>{stateText(run, now)}</Text>
            <LiveLine theme={theme} run={run} />
            <View style={{ flexDirection: "row", gap: 12, marginLeft: "auto" }}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Show logs of ${run.name}`} onPress={() => onLogs(run.key)}>
                <Text style={link}>Logs</Text>
              </Pressable>
              <StopButton theme={theme} run={run} />
            </View>
          </View>
          <HealthBadges theme={theme} run={run} />
        </View>
      ))}
      {all.length > LIVE_ROWS ? (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
          <Text style={link}>{expanded ? "Show fewer" : `Show all ${all.length} live runs`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Logs({
  theme,
  runs,
  labels,
  colors,
  dashes,
  selectedKey,
  onSelect,
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  labels: Map<string, string>;
  colors: Map<string, string>;
  dashes: Map<string, Dash>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const run = runs.find((candidate) => candidate.key === selectedKey) ?? runs.find(isActive) ?? runs[0];
  const now = useNow(15_000);
  return (
    <View style={{ gap: 10 }}>
      {runs.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {runs.map((candidate) => (
            <Chip
              key={candidate.key}
              theme={theme}
              label={labels.get(candidate.key) ?? candidate.name}
              color={colors.get(candidate.key)}
              dash={dashes.get(candidate.key)}
              status={stateColor(candidate, theme, now)}
              selected={candidate.key === run.key}
              onPress={() => onSelect(candidate.key)}
              accessibilityLabel={`Show logs of ${candidate.name}`}
            />
          ))}
        </View>
      ) : null}
      <LogsView key={run.key} theme={theme} run={run} />
    </View>
  );
}

/** Compares the selected runs: overlaid charts with W&B's chart controls, or a config and summary table. */
export function Explorer({
  theme,
  compact,
  runs,
  selection,
  prefs,
  onPrefs,
  onRemove,
}: {
  theme: PluginTheme;
  compact: boolean;
  /** Full rows of the selected runs, in any order. */
  runs: WandbRun[];
  selection: Selection;
  prefs: ChartPrefs;
  onPrefs: (prefs: ChartPrefs) => void;
  onRemove?: (key: string) => void;
}) {
  const ordered = useMemo(
    () => selection.map((entry) => runs.find((run) => run.key === entry.key)).filter((run): run is WandbRun => run !== undefined),
    [runs, selection],
  );
  const colors = useMemo(() => new Map(selection.map((entry) => [entry.key, seriesColor(theme, entry.slot)])), [selection, theme]);
  const dashes = useMemo(() => new Map(selection.map((entry) => [entry.key, seriesDash(entry.slot)])), [selection]);
  const groupKeys = useMemo(() => differingConfigKeys(ordered), [ordered]);
  const groupBy = prefs.groupBy === "group" || prefs.groupBy === "jobType" || groupKeys.includes(prefs.groupBy.slice(7)) ? prefs.groupBy : "";
  const labels = useMemo(() => runLabels(ordered), [ordered]);
  const entities = useMemo<Entity[]>(() => {
    if (!groupBy) return ordered.map((run) => ({ id: run.key, label: labels.get(run.key)!, color: colors.get(run.key)!, dash: dashes.get(run.key)!, runKeys: [run.key] }));
    const groups = new Map<string, string[]>();
    for (const run of ordered) {
      const value = groupValue(run, groupBy);
      groups.set(value, [...(groups.get(value) ?? []), run.key]);
    }
    const name = groupBy.startsWith("config.") ? groupBy.slice(7) : groupBy;
    return [...groups.entries()].map(([value, runKeys], index) => ({
      id: `group:${value}`,
      label: `${name}=${value}`,
      color: seriesColor(theme, index),
      dash: seriesDash(index),
      runKeys,
    }));
  }, [ordered, groupBy, colors, dashes, labels, theme]);
  // Pressing a legend entry highlights its lines and fades the rest; pressing it again clears that.
  const [picked, setPicked] = useState<string | null>(null);
  const highlight = entities.some((entity) => entity.id === picked) ? picked : null;
  const set = (patch: Partial<ChartPrefs>) => onPrefs({ ...prefs, ...patch });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const [logsKey, setLogsKey] = useState<string | null>(null);
  const [mediaKey, setMediaKey] = useState<string | null>(null);

  if (ordered.length === 0) {
    return <Text style={{ ...muted, fontSize: 13, paddingVertical: 8 }}>Pick runs to chart and compare them.</Text>;
  }
  return (
    <View style={{ gap: 14 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <Segmented
          theme={theme}
          label="View"
          value={prefs.view}
          options={[
            { value: "charts", label: "Charts" },
            { value: "media", label: "Media" },
            { value: "logs", label: "Logs" },
            { value: "table", label: "Compare table" },
          ]}
          onChange={(view) => set({ view })}
        />
        {prefs.view === "charts" ? (
          <>
            <Field theme={theme} label="Filter metrics" placeholder="Filter metrics (regex)" value={prefs.search} onChange={(search) => set({ search })} width={compact ? undefined : 200} />
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={muted}>Smoothing</Text>
              <Slider theme={theme} label="Smoothing" value={prefs.smoothing} min={0} max={0.99} step={0.01} onChange={(smoothing) => set({ smoothing })} />
              <Text style={{ ...muted, width: 30, fontVariant: ["tabular-nums"] }}>{prefs.smoothing.toFixed(2)}</Text>
            </View>
            <Segmented
              theme={theme}
              label="X axis"
              value={prefs.xAxis}
              options={[
                { value: "step", label: "Step" },
                { value: "runtime", label: "Relative time" },
                { value: "wall", label: "Wall time" },
              ]}
              onChange={(xAxis) => set({ xAxis, window: null })}
            />
            <Toggle theme={theme} label="Log scale" value={prefs.logY} onChange={(logY) => set({ logY })} />
          </>
        ) : prefs.view === "table" ? (
          <Toggle theme={theme} label="Only differences" value={prefs.diffOnly} onChange={(diffOnly) => set({ diffOnly })} />
        ) : null}
      </View>
      {prefs.view === "charts" && ordered.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text style={muted}>Group by</Text>
          <Chip theme={theme} label="None" selected={!groupBy} onPress={() => set({ groupBy: "" })} />
          {ordered.some((run) => run.group) ? <Chip theme={theme} label="run group" selected={groupBy === "group"} onPress={() => set({ groupBy: "group" })} /> : null}
          {new Set(ordered.map((run) => run.jobType)).size > 1 ? (
            <Chip theme={theme} label="job type" selected={groupBy === "jobType"} onPress={() => set({ groupBy: "jobType" })} />
          ) : null}
          {groupKeys.map((key) => (
            <Chip key={key} theme={theme} label={key} selected={groupBy === `config.${key}`} onPress={() => set({ groupBy: `config.${key}` })} />
          ))}
        </View>
      ) : null}
      {/* The legend names every chart line's color; the table's header does that itself. */}
      {prefs.view === "charts" ? (
        <View accessibilityLabel="Legend" style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {entities.map((entity) => (
            <View key={entity.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: highlight === entity.id }}
                accessibilityLabel={`${highlight === entity.id ? "Stop highlighting" : "Highlight"} ${entity.label}`}
                onPress={() => setPicked(highlight === entity.id ? null : entity.id)}
                style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: highlight && highlight !== entity.id ? 0.45 : 1 }}
              >
                <LineKey color={entity.color} dash={entity.dash} width={16} />
                <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: highlight === entity.id ? "600" : "400" }} numberOfLines={1}>
                  {entity.label}
                  {entity.runKeys.length > 1 ? ` (${entity.runKeys.length} runs)` : ""}
                </Text>
              </Pressable>
              {onRemove && entity.runKeys.length === 1 ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Stop comparing ${entity.label}`} onPress={() => onRemove(entity.id)} hitSlop={6}>
                  <Text style={muted}>×</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      <LiveStrip
        theme={theme}
        runs={ordered}
        labels={labels}
        colors={colors}
        dashes={dashes}
        onLogs={(key) => {
          setLogsKey(key);
          set({ view: "logs" });
        }}
      />
      {prefs.view === "charts" ? (
        <Charts theme={theme} compact={compact} runs={ordered} entities={entities} prefs={prefs} onPrefs={onPrefs} highlight={highlight} />
      ) : prefs.view === "media" ? (
        <MediaPane theme={theme} compact={compact} runs={ordered} labels={labels} colors={colors} selectedKey={mediaKey} onSelect={setMediaKey} />
      ) : prefs.view === "logs" ? (
        <Logs theme={theme} runs={ordered} labels={labels} colors={colors} dashes={dashes} selectedKey={logsKey} onSelect={setLogsKey} />
      ) : (
        <CompareTable theme={theme} runs={ordered} labels={labels} colors={colors} dashes={dashes} diffOnly={prefs.diffOnly} />
      )}
    </View>
  );
}
