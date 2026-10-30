import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, Markdown } from "@getpaseo/plugin/client/ui";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  isLive,
  type ReportPanel,
  type ReportRunSet,
  type ReportSeries,
  type ReportSummary,
  reportRpc,
  reportSeriesRpc,
  reportsRpc,
  type WandbRun,
} from "../shared/wandb";
import { ChartCard, type ChartLine, ChartGrid, PLOT_HEIGHT, Polyline, padRange } from "./chart";
import { CompareTable } from "./compare";
import { Field, LineKey } from "./controls";
import { runLabels, seriesColor } from "./model";
import { aggregate, extent, smooth, toLog, type XY } from "./series";
import { duration, formatPair, formatValue, useNow, useRunsByKey } from "./state";

/** Line plots draw at most this many runs; more cannot be told apart. */
const MAX_CHART_RUNS = 12;
const SERIES_POLL_MS = 15_000;

export function useReports() {
  const fetchReports = useRpc(reportsRpc);
  return useQuery({ queryKey: ["wandb-reports"], queryFn: () => fetchReports({}), staleTime: 60_000, retry: 1 });
}

export function ReportsList({
  theme,
  selectedId,
  onOpen,
}: {
  theme: PluginTheme;
  selectedId: string | null;
  onOpen: (report: ReportSummary) => void;
}) {
  const reports = useReports();
  const now = useNow(60_000);
  const [search, setSearch] = useState("");
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (reports.isPending) return <View style={{ height: 120 }}><Loading /></View>;
  if (reports.error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Could not list reports: {reports.error.message}</Text>;
  const needle = search.trim().toLowerCase();
  const shown = reports.data.reports.filter(
    (report) => !needle || `${report.title} ${report.project} ${report.description ?? ""}`.toLowerCase().includes(needle),
  );
  return (
    <View style={{ gap: 10 }}>
      <Field theme={theme} label="Search reports" placeholder="Search reports" value={search} onChange={setSearch} delayMs={150} />
      <Text style={muted}>{shown.length} {shown.length === 1 ? "report" : "reports"}</Text>
      {shown.length === 0 ? <Text style={muted}>{needle ? "No reports match." : "No reports in your W&B projects yet."}</Text> : null}
      {shown.map((report) => {
        const selected = report.id === selectedId;
        return (
          <Pressable
            key={report.id}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Open report ${report.title}`}
            onPress={() => onOpen(report)}
            style={{
              gap: 3,
              padding: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }} numberOfLines={2}>
              {report.title}
            </Text>
            <Text style={muted} numberOfLines={1}>
              {[report.project, report.author, report.updatedAt ? `updated ${duration((now - Date.parse(report.updatedAt)) / 1000)} ago` : null].filter(Boolean).join(" · ")}
            </Text>
            {report.description ? (
              <Text style={muted} numberOfLines={2}>
                {report.description}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

/** "1,234,500 to 1,234,900" for a range on a linear or log axis. */
function rangeText(range: { min: number; max: number }, log: boolean): string {
  const [low, high] = formatPair(log ? 10 ** range.min : range.min, log ? 10 ** range.max : range.max);
  return `${low} to ${high}`;
}

function numeric(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** A run's value for `config.<key>`, `summary.<key>`, or a run field. */
function fieldValue(run: WandbRun, field: string): number | null {
  if (field.startsWith("config.")) return numeric(run.config?.[field.slice(7)]);
  if (field.startsWith("summary.")) return numeric(run.summary?.[field.slice(8)]);
  if (field === "runtime" || field === "duration") return run.runtime;
  if (field === "step") return run.step;
  if (field === "createdAt") return Date.parse(run.createdAt) / 1000;
  return null;
}

const fieldName = (field: string) => field.replace(/^(config|summary)\./, "");

/** How a panel grid colors runs: one color per run when they fit, else one per run set. */
interface Palette {
  colorOf: (key: string) => string;
  legend: { label: string; color: string }[];
  labelOf: (key: string) => string;
}

function Card({ theme, width, title, children }: { theme: PluginTheme; width: number; title: string | null; children: ReactNode }) {
  return (
    <View style={{ width, padding: 10, gap: 6, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      {title ? (
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
          {title}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

function ScalarCard({ theme, width, panel, runs }: { theme: PluginTheme; width: number; panel: Extract<ReportPanel, { kind: "scalar" }>; runs: WandbRun[] }) {
  const values = runs.map((run) => fieldValue(run, `summary.${panel.metric}`)).filter((value): value is number => value !== null);
  const range = extent(values);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return (
    <Card theme={theme} width={width} title={panel.title ?? panel.metric}>
      <View style={{ height: PLOT_HEIGHT, alignItems: "center", justifyContent: "center", gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 32, fontWeight: "600", fontVariant: ["tabular-nums"] }}>
          {mean !== null ? formatValue(mean) : "—"}
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {values.length > 1 && range ? `mean of ${values.length} runs · ${formatValue(range.min)} to ${formatValue(range.max)}` : panel.metric}
        </Text>
      </View>
    </Card>
  );
}

function BarCard({
  theme,
  width,
  panel,
  runs,
  palette,
}: {
  theme: PluginTheme;
  width: number;
  panel: Extract<ReportPanel, { kind: "bar" }>;
  runs: WandbRun[];
  palette: Palette;
}) {
  const bars = panel.metrics.flatMap((metric) =>
    runs.flatMap((run) => {
      const value = fieldValue(run, `summary.${metric}`);
      return value === null ? [] : [{ id: `${run.key}:${metric}`, label: panel.metrics.length > 1 ? `${palette.labelOf(run.key)} · ${metric}` : palette.labelOf(run.key), value, color: palette.colorOf(run.key) }];
    }),
  );
  const low = Math.min(0, ...bars.map((bar) => bar.value));
  const high = Math.max(0, ...bars.map((bar) => bar.value));
  const span = high - low || 1;
  const track = Math.max(40, width - 22 - 120 - 60);
  // Bars grow from zero, so negative values (such as deltas) extend left of it.
  const zero = ((0 - low) / span) * track;
  return (
    <Card theme={theme} width={width} title={panel.title ?? panel.metrics.join(", ")}>
      {bars.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>No values yet.</Text> : null}
      {bars.map((bar) => {
        const end = ((bar.value - low) / span) * track;
        return (
          <View key={bar.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ width: 120, color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {bar.label}
            </Text>
            <View style={{ width: track, height: 10 }}>
              <View style={{ position: "absolute", left: zero, top: -2, bottom: -2, width: 1, backgroundColor: theme.colors.border }} />
              <View style={{ position: "absolute", left: Math.min(zero, end), width: Math.max(1, Math.abs(end - zero)), height: 10, borderRadius: 2, backgroundColor: bar.color }} />
            </View>
            <Text style={{ width: 60, color: theme.colors.foreground, fontSize: 11, fontVariant: ["tabular-nums"] }}>{formatValue(bar.value)}</Text>
          </View>
        );
      })}
    </Card>
  );
}

function ScatterCard({
  theme,
  width,
  panel,
  runs,
  palette,
}: {
  theme: PluginTheme;
  width: number;
  panel: Extract<ReportPanel, { kind: "scatter" }>;
  runs: WandbRun[];
  palette: Palette;
}) {
  const plotWidth = Math.max(0, width - 22);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const transform = (value: number | null, log: boolean) => (value === null ? null : log ? (value > 0 ? Math.log10(value) : null) : value);
  const points = runs.flatMap((run) => {
    const x = transform(fieldValue(run, panel.x), panel.logX);
    const y = transform(fieldValue(run, panel.y), panel.logY);
    return x === null || y === null ? [] : [{ run, x, y }];
  });
  const xs = padRange(extent(points.map((point) => point.x)) ?? { min: 0, max: 1 });
  const ys = padRange(extent(points.map((point) => point.y)) ?? { min: 0, max: 1 });
  const toPixel = (point: { x: number; y: number }) => ({
    left: ((point.x - xs.min) / (xs.max - xs.min)) * plotWidth,
    top: PLOT_HEIGHT - ((point.y - ys.min) / (ys.max - ys.min)) * PLOT_HEIGHT,
  });
  const show = (value: number, log: boolean) => formatValue(log ? 10 ** value : value);
  const near = hover
    ? points
        .map((point) => ({ point, distance: Math.hypot(toPixel(point).left - hover.x, toPixel(point).top - hover.y) }))
        .sort((a, b) => a.distance - b.distance)
        .find((candidate) => candidate.distance < 24)?.point
    : undefined;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 10 };
  return (
    <Card theme={theme} width={width} title={panel.title ?? `${fieldName(panel.y)} vs ${fieldName(panel.x)}`}>
      <View style={{ height: PLOT_HEIGHT, width: plotWidth }}>
        <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 1, backgroundColor: theme.colors.border }} />
        <View style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 1, backgroundColor: theme.colors.border }} />
        {points.map((point) => {
          const { left, top } = toPixel(point);
          return (
            <View
              key={point.run.key}
              pointerEvents="none"
              style={{ position: "absolute", left: left - 4, top: top - 4, width: 8, height: 8, borderRadius: 4, backgroundColor: palette.colorOf(point.run.key), borderWidth: near === point ? 2 : 0, borderColor: theme.colors.foreground }}
            />
          );
        })}
        {near ? (
          <View pointerEvents="none" style={{ position: "absolute", top: 4, right: 4, padding: 6, gap: 2, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{palette.labelOf(near.run.key)}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {fieldName(panel.x)} {show(near.x, panel.logX)} · {fieldName(panel.y)} {show(near.y, panel.logY)}
            </Text>
          </View>
        ) : null}
        <View
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          onPointerMove={(event) => setHover({ x: event.nativeEvent.offsetX, y: event.nativeEvent.offsetY })}
          onPointerLeave={() => setHover(null)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={(event) => setHover({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY })}
          onResponderMove={(event) => setHover({ x: event.nativeEvent.locationX, y: event.nativeEvent.locationY })}
          onResponderRelease={() => setHover(null)}
        />
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={muted} numberOfLines={1}>
          {fieldName(panel.x)} {points.length ? rangeText(xs, panel.logX) : ""}
        </Text>
        <Text style={muted} numberOfLines={1}>
          {fieldName(panel.y)} {points.length ? rangeText(ys, panel.logY) : ""}
        </Text>
      </View>
    </Card>
  );
}

function ParallelCard({
  theme,
  width,
  panel,
  runs,
  palette,
}: {
  theme: PluginTheme;
  width: number;
  panel: Extract<ReportPanel, { kind: "parallel" }>;
  runs: WandbRun[];
  palette: Palette;
}) {
  const plotWidth = Math.max(0, width - 22);
  const height = PLOT_HEIGHT + 30;
  const columns = panel.columns.map((column) => {
    const values = runs.map((run) => {
      const value = fieldValue(run, column.field);
      return value === null ? null : column.log ? (value > 0 ? Math.log10(value) : null) : value;
    });
    const range = extent(values.filter((value): value is number => value !== null)) ?? { min: 0, max: 1 };
    return { ...column, values, range: range.min === range.max ? { min: range.min - 1, max: range.max + 1 } : range };
  });
  const xOf = (index: number) => (columns.length === 1 ? plotWidth / 2 : (index / (columns.length - 1)) * plotWidth);
  // Each axis maps its own range to 0..1, flipped for inverted columns, so lines share one coordinate space.
  const lines = runs.map((run, runIndex) => {
    const points: XY[] = [];
    columns.forEach((column, index) => {
      const value = column.values[runIndex];
      if (value === null) return;
      const fraction = (value - column.range.min) / (column.range.max - column.range.min);
      points.push({ x: xOf(index), y: column.inverted ? 1 - fraction : fraction });
    });
    return { run, points };
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 9 };
  return (
    <Card theme={theme} width={width} title={panel.title ?? "Parallel coordinates"}>
      <View style={{ height, width: plotWidth }}>
        <View style={{ position: "absolute", top: 14, left: 0, right: 0, height: PLOT_HEIGHT }}>
          {columns.map((column, index) => (
            <View key={column.field} style={{ position: "absolute", left: xOf(index), top: 0, bottom: 0, width: 1, backgroundColor: theme.colors.border }} />
          ))}
          {lines.map(({ run, points }) => (
            <Polyline key={run.key} points={points} width={plotWidth} height={PLOT_HEIGHT} color={palette.colorOf(run.key)} xRange={{ min: 0, max: plotWidth }} yRange={{ min: 0, max: 1 }} lineWidth={1.25} opacity={0.8} />
          ))}
        </View>
        {columns.map((column, index) => {
          // Each label gets its axis's share of the width, so neighbors never overlap; the end axes get half a share, aligned to the edge.
          const slot = columns.length > 1 ? plotWidth / (columns.length - 1) : plotWidth;
          const first = index === 0;
          const last = index === columns.length - 1 && columns.length > 1;
          const labelWidth = first || last ? slot / 2 - 2 : slot - 4;
          const left = first ? 0 : last ? plotWidth - labelWidth : xOf(index) - labelWidth / 2;
          const align = first ? ("left" as const) : last ? ("right" as const) : ("center" as const);
          const [low, high] = formatPair(column.log ? 10 ** column.range.min : column.range.min, column.log ? 10 ** column.range.max : column.range.max);
          return (
            <View key={column.field} pointerEvents="none">
              <Text numberOfLines={1} style={{ ...muted, position: "absolute", top: 0, left, width: labelWidth, textAlign: align, color: theme.colors.foreground }}>
                {fieldName(column.field)}
              </Text>
              <Text numberOfLines={1} style={{ ...muted, position: "absolute", top: 14 + PLOT_HEIGHT + 2, left, width: labelWidth, textAlign: align }}>
                {column.inverted ? `${high}↓${low}` : `${low}–${high}`}
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

function toPanelXY(points: ReportSeries["points"], panel: Extract<ReportPanel, { kind: "line" }>): XY[] {
  const index = panel.customX ? 4 : panel.xAxis === "step" ? 0 : panel.xAxis === "runtime" ? 1 : 2;
  return points
    .flatMap((point) => {
      const x = point[index];
      return x === null ? [] : [{ x, y: point[3] }];
    })
    .sort((a, b) => a.x - b.x);
}

function LinePanel({
  theme,
  width,
  panel,
  runs,
  series,
  palette,
  groupBy,
}: {
  theme: PluginTheme;
  width: number;
  panel: Extract<ReportPanel, { kind: "line" }>;
  runs: WandbRun[];
  series: Map<string, ReportSeries>;
  palette: Palette;
  groupBy: string;
}) {
  const lines = useMemo(() => {
    const result: ChartLine[] = [];
    const prepare = (points: XY[]) => (panel.logY ? toLog(points) : points);
    panel.metrics.forEach((metric, metricIndex) => {
      const suffix = panel.metrics.length > 1 ? ` · ${metric}` : "";
      // One run with several metrics colors by metric; otherwise each run keeps its grid color.
      const colorFor = (key: string) => (panel.metrics.length > 1 && runs.length === 1 ? seriesColor(theme, metricIndex) : palette.colorOf(key));
      if (groupBy) {
        // W&B draws a grouped run set as each group's mean with its range.
        const groups = new Map<string, WandbRun[]>();
        for (const run of runs) {
          const value = groupBy === "group" ? run.group : groupBy === "jobType" ? run.jobType : run.config?.[groupBy.slice(7)];
          const label = value === null || value === undefined || value === "" ? "none" : String(value);
          groups.set(label, [...(groups.get(label) ?? []), run]);
        }
        [...groups.entries()].forEach(([label, members], groupIndex) => {
          const { mean, min, max } = aggregate(members.map((run) => prepare(toPanelXY(series.get(`${run.key} ${metric}`)?.points ?? [], panel))));
          const color = seriesColor(theme, groupIndex + metricIndex);
          const name = `${groupBy.replace(/^config\./, "")}=${label}${suffix}`;
          if (!mean.length) return;
          result.push({ id: `${name}:min`, label: `${name} min`, color, points: smooth(min, panel.smoothing), faint: true });
          result.push({ id: `${name}:max`, label: `${name} max`, color, points: smooth(max, panel.smoothing), faint: true });
          result.push({ id: name, label: `${name} mean`, color, points: smooth(mean, panel.smoothing) });
        });
        return;
      }
      runs.forEach((run) => {
        const raw = prepare(toPanelXY(series.get(`${run.key} ${metric}`)?.points ?? [], panel));
        if (!raw.length) return;
        const color = colorFor(run.key);
        if (panel.smoothing > 0 && runs.length <= 3) result.push({ id: `${run.key}:${metric}:raw`, label: palette.labelOf(run.key), color, points: raw, faint: true });
        result.push({ id: `${run.key}:${metric}`, label: `${palette.labelOf(run.key)}${suffix}`, color, points: smooth(raw, panel.smoothing) });
      });
    });
    return result;
  }, [panel, runs, series, palette, groupBy, theme]);
  return (
    <ChartCard
      theme={theme}
      title={panel.title ?? panel.metrics.join(", ")}
      lines={lines}
      width={width}
      xAxis={panel.xAxis}
      customX={panel.customX}
      logY={panel.logY}
      ignoreOutliers={panel.ignoreOutliers}
      segmentsPerLine={Math.ceil(width / (runs.length <= 2 ? 4 : runs.length <= 4 ? 6 : 8))}
    />
  );
}

/** One of a report's panel grids: its run sets resolved, its panels drawn natively where possible. */
function PanelGrid({
  theme,
  compact,
  runSets,
  panels,
  reportUrl,
}: {
  theme: PluginTheme;
  compact: boolean;
  runSets: ReportRunSet[];
  panels: ReportPanel[];
  reportUrl: string;
}) {
  const fetchSeries = useRpc(reportSeriesRpc);
  const allKeys = useMemo(() => runSets.flatMap((runSet) => runSet.runKeys), [runSets]);
  const rows = useRunsByKey(allKeys, false);
  const runs = useMemo(() => allKeys.flatMap((key) => rows.data?.runs.find((run) => run.key === key) ?? []), [allKeys, rows.data]);
  const anyActive = runs.some(isLive);
  // Line plots take runs from each run set in turn, so every set is represented.
  const chartKeys = useMemo(() => {
    const queues = runSets.map((runSet) => [...runSet.runKeys]);
    const picked: string[] = [];
    while (picked.length < MAX_CHART_RUNS && queues.some((queue) => queue.length)) {
      for (const queue of queues) if (queue.length && picked.length < MAX_CHART_RUNS) picked.push(queue.shift()!);
    }
    return picked;
  }, [runSets]);
  const bySet = runSets.length > 1 || chartKeys.length > 8;
  const palette = useMemo<Palette>(() => {
    const setOf = new Map(runSets.flatMap((runSet, index) => runSet.runKeys.map((key) => [key, index] as const)));
    const labels = runLabels(runs);
    const order = new Map(chartKeys.map((key, index) => [key, index]));
    return {
      colorOf: (key) => seriesColor(theme, bySet ? (setOf.get(key) ?? 0) : (order.get(key) ?? allKeys.indexOf(key))),
      labelOf: (key) => labels.get(key) ?? key.split("/").pop() ?? key,
      legend: bySet
        ? runSets.slice(0, 8).map((runSet, index) => ({ label: runSet.name, color: seriesColor(theme, index) }))
        : chartKeys.map((key, index) => ({ label: labels.get(key) ?? key.split("/").pop() ?? key, color: seriesColor(theme, index) })),
    };
  }, [runSets, runs, chartKeys, allKeys, bySet, theme]);

  const linePanels = panels.filter((panel): panel is Extract<ReportPanel, { kind: "line" }> => panel.kind === "line");
  const byX = useMemo(() => {
    const groups = new Map<string, Set<string>>();
    for (const panel of linePanels) {
      const x = panel.customX ?? "";
      groups.set(x, new Set([...(groups.get(x) ?? []), ...panel.metrics]));
    }
    return [...groups.entries()].map(([x, keys]) => ({ x: x || null, keys: [...keys].sort().slice(0, 30) }));
  }, [linePanels]);
  const seriesResults = useQueries({
    queries: byX.map(({ x, keys }) => ({
      queryKey: ["wandb-report-series", chartKeys, keys, x],
      queryFn: () => fetchSeries({ runKeys: chartKeys, keys, x }),
      enabled: chartKeys.length > 0,
      refetchInterval: anyActive ? SERIES_POLL_MS : (false as const),
      retry: 1,
    })),
  });
  const seriesFor = (x: string | null) => {
    const index = byX.findIndex((group) => group.x === x);
    return new Map((seriesResults[index]?.data?.series ?? []).map((entry) => [`${entry.runKey} ${entry.key}`, entry] as const));
  };
  const chartRuns = chartKeys.flatMap((key) => runs.find((run) => run.key === key) ?? []);
  const groupBy = runSets.length === 1 ? runSets[0].groupBy : "";

  // Wide panels (parallel coordinates, the run comparer) take the grid's full width below the cards.
  const drawable = panels.filter((panel) => panel.kind !== "unsupported" && panel.kind !== "comparer" && panel.kind !== "markdown" && panel.kind !== "parallel");
  const [fullWidth, setFullWidth] = useState(0);
  const unsupported = panels.filter((panel): panel is Extract<ReportPanel, { kind: "unsupported" }> => panel.kind === "unsupported");
  const counts = new Map<string, number>();
  for (const panel of unsupported) counts.set(panel.type, (counts.get(panel.type) ?? 0) + 1);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const extra = runSets.reduce((sum, runSet) => sum + Math.max(0, (runSet.total ?? 0) - runSet.runKeys.length), 0);

  return (
    <View style={{ gap: 10, paddingVertical: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        {palette.legend.map((entry) => (
          <View key={entry.label} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <LineKey color={entry.color} width={16} />
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }} numberOfLines={1}>
              {entry.label}
            </Text>
          </View>
        ))}
        {rows.isFetching ? <Text style={muted}>Updating…</Text> : null}
      </View>
      {runSets.map((runSet) => (runSet.note ? <Text key={runSet.name} style={muted}>{runSet.name}: {runSet.note}</Text> : null))}
      {extra > 0 || allKeys.length > chartKeys.length ? (
        <Text style={muted}>
          {[
            allKeys.length > chartKeys.length ? `Line plots draw ${chartKeys.length} of these ${allKeys.length} runs` : null,
            extra > 0 ? `${extra} more matching runs are only in W&B` : null,
          ]
            .filter(Boolean)
            .join("; ")}
          .
        </Text>
      ) : null}
      {rows.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{rows.error.message}</Text> : null}
      <ChartGrid compact={compact}>
        {(width) =>
          drawable.map((panel, index) => {
            const key = `${panel.kind}-${index}`;
            switch (panel.kind) {
              case "line":
                return <LinePanel key={key} theme={theme} width={width} panel={panel} runs={chartRuns} series={seriesFor(panel.customX)} palette={palette} groupBy={groupBy} />;
              case "scalar":
                return <ScalarCard key={key} theme={theme} width={width} panel={panel} runs={runs} />;
              case "bar":
                return <BarCard key={key} theme={theme} width={width} panel={panel} runs={runs} palette={palette} />;
              case "scatter":
                return <ScatterCard key={key} theme={theme} width={width} panel={panel} runs={runs} palette={palette} />;
              default:
                return null;
            }
          })
        }
      </ChartGrid>
      <View onLayout={(event) => setFullWidth(Math.floor(event.nativeEvent.layout.width))} style={{ gap: 10 }}>
        {fullWidth > 0
          ? panels.map((panel, index) =>
              panel.kind === "parallel" ? <ParallelCard key={`parallel-${index}`} theme={theme} width={fullWidth} panel={panel} runs={runs} palette={palette} /> : null,
            )
          : null}
      </View>
      {panels.map((panel, index) =>
        panel.kind === "markdown" ? (
          <Markdown key={`markdown-${index}`}>{panel.text}</Markdown>
        ) : panel.kind === "comparer" ? (
          <CompareTable
            key={`comparer-${index}`}
            theme={theme}
            runs={runs.slice(0, 8)}
            labels={new Map(runs.map((run) => [run.key, palette.labelOf(run.key)]))}
            colors={new Map(runs.map((run) => [run.key, palette.colorOf(run.key)]))}
            diffOnly={panel.diffOnly}
          />
        ) : null,
      )}
      {counts.size ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          <Text style={muted}>
            Not drawn here: {[...counts.entries()].map(([type, count]) => (count > 1 ? `${count} ${type} panels` : `a ${type} panel`)).join(", ")}.
          </Text>
          <ExternalLink href={reportUrl} accessibilityLabel="Open the report in W&B">
            <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Open in W&B</Text>
          </ExternalLink>
        </View>
      ) : null}
    </View>
  );
}

/** A W&B report drawn natively: text as Markdown, panel grids with live charts. */
export function ReportView({
  theme,
  compact,
  id,
  onBack,
  openBrowser,
}: {
  theme: PluginTheme;
  compact: boolean;
  id: string;
  onBack?: () => void;
  /** Opens the real report page in a workspace browser tab; Electron only. */
  openBrowser?: (url: string) => void;
}) {
  const fetchReport = useRpc(reportRpc);
  const now = useNow(60_000);
  const report = useQuery({ queryKey: ["wandb-report", id], queryFn: () => fetchReport({ id }), staleTime: 60_000, retry: 1 });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };
  return (
    <View style={{ gap: 16, maxWidth: 1200 }}>
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Back to reports" onPress={onBack}>
          <Text style={link}>‹ Reports</Text>
        </Pressable>
      ) : null}
      {report.isPending ? (
        <View style={{ height: 160 }}>
          <Loading />
        </View>
      ) : report.error ? (
        <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Could not load the report: {report.error.message}</Text>
      ) : (
        <>
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: compact ? 20 : 24, fontWeight: "700" }}>{report.data.report.title}</Text>
            {report.data.report.description ? <Text style={{ ...muted, fontSize: 13 }}>{report.data.report.description}</Text> : null}
            <Text style={muted}>
              {[
                `${report.data.report.entity}/${report.data.report.project}`,
                report.data.report.author,
                report.data.report.updatedAt ? `updated ${duration((now - Date.parse(report.data.report.updatedAt)) / 1000)} ago` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
              <ExternalLink href={report.data.report.url} accessibilityLabel="Open the report in W&B">
                <Text style={link}>Open in W&B</Text>
              </ExternalLink>
              {openBrowser ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Open the full report in a browser tab" onPress={() => openBrowser(report.data.report.url)}>
                  <Text style={link}>Open full report in a tab</Text>
                </Pressable>
              ) : null}
              {report.isFetching ? <Text style={muted}>Updating…</Text> : null}
            </View>
          </View>
          {report.data.blocks.map((block, index) => {
            switch (block.kind) {
              case "markdown":
                return <Markdown key={index}>{block.text}</Markdown>;
              case "callout":
                return (
                  <View
                    key={index}
                    style={{ padding: 12, borderRadius: 8, borderLeftWidth: 3, borderLeftColor: theme.colors.accent, backgroundColor: theme.colors.surface1 }}
                  >
                    <Markdown>{block.text}</Markdown>
                  </View>
                );
              case "panels":
                return <PanelGrid key={index} theme={theme} compact={compact} runSets={block.runSets} panels={block.panels} reportUrl={report.data.report.url} />;
              case "unsupported":
                return (
                  <Text key={index} style={muted}>
                    A {block.type} block is not shown here; open the report in W&B to see it.
                  </Text>
                );
            }
          })}
        </>
      )}
    </View>
  );
}
