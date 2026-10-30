import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, Modal, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { Image, type LayoutChangeEvent, Pressable, Text, View } from "react-native";
import { isLive, type MediaEntry, type MediaItem, mediaFileRpc, mediaIndexRpc, type TableCell, type WandbRun } from "../shared/wandb";
import { ChartCard, type ChartLine, PLOT_HEIGHT } from "./chart";
import { Chip, Field, Slider } from "./controls";
import { seriesColor } from "./model";
import { extent, metricMatcher } from "./series";
import { formatPair, formatValue } from "./state";

const IMAGES_PER_STEP = 24;
const TILE_HEIGHT = 360;
const TABLE_PAGE = 100;
const CELL_WIDTH = 140;

function useMediaIndex(run: WandbRun) {
  const fetchIndex = useRpc(mediaIndexRpc);
  return useQuery({
    queryKey: ["wandb-media", run.key],
    queryFn: () => fetchIndex({ entity: run.entity, project: run.project, id: run.id }),
    refetchInterval: isLive(run) ? 30_000 : false,
    retry: 1,
  });
}

/** One of the run's files; files never change once logged, so they are fetched once. */
function useMediaFile(run: WandbRun, path: string | null) {
  const fetchFile = useRpc(mediaFileRpc);
  return useQuery({
    queryKey: ["wandb-media-file", run.key, path],
    queryFn: () => fetchFile({ entity: run.entity, project: run.project, id: run.id, path: path! }),
    enabled: path !== null,
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  });
}

function useWidth(): [number, (event: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  return [width, (event) => setWidth(Math.floor(event.nativeEvent.layout.width))];
}

function Card({ theme, title, detail, children }: { theme: PluginTheme; title: string; detail?: string | null; children: ReactNode }) {
  return (
    <View style={{ gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>{title}</Text>
        {detail ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{detail}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** Picks one logged step of a media key; the newest by default. */
function StepPicker({ theme, entries, index, onChange }: { theme: PluginTheme; entries: MediaEntry[]; index: number; onChange: (index: number) => void }) {
  if (entries.length < 2) return null;
  const step = entries[index]?.step;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Step</Text>
      <Slider theme={theme} label="Logged step" value={index} min={0} max={entries.length - 1} step={1} width={180} onChange={onChange} />
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
        {step !== null && step !== undefined ? formatValue(step) : "summary"} ({index + 1} of {entries.length})
      </Text>
    </View>
  );
}

function MediaImage({ theme, run, path, width, aspect, caption, onPress, maxHeight }: {
  theme: PluginTheme;
  run: WandbRun;
  path: string;
  width: number;
  /** Height over width, from what W&B recorded; 3:4 until known. */
  aspect: number;
  caption?: string | null;
  onPress?: () => void;
  /** Tall images shrink to fit this height; enlarging shows them whole. */
  maxHeight?: number;
}) {
  const file = useMediaFile(run, path);
  const height = Math.max(24, Math.round(Math.min(width * aspect, maxHeight ?? Infinity)));
  const body =
    file.data?.kind === "image" ? (
      <Image source={{ uri: file.data.uri }} style={{ width, height, borderRadius: 4 }} resizeMode="contain" accessibilityLabel={caption ?? path} />
    ) : (
      <View style={{ width, height, borderRadius: 4, backgroundColor: theme.colors.surface2, alignItems: "center", justifyContent: "center", padding: 6 }}>
        {file.isPending ? (
          <Loading />
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textAlign: "center" }}>
            {file.data?.kind === "unavailable" ? file.data.reason : (file.error?.message ?? "Not an image")}
          </Text>
        )}
      </View>
    );
  return (
    <View style={{ width, gap: 3 }}>
      {onPress ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Enlarge ${caption ?? path}`} onPress={onPress}>
          {body}
        </Pressable>
      ) : (
        body
      )}
      {caption ? (
        <Text numberOfLines={2} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

function ImagesItem({ theme, run, item, compact }: { theme: PluginTheme; run: WandbRun; item: MediaItem; compact: boolean }) {
  const [index, setIndex] = useState(item.entries.length - 1);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [width, onLayout] = useWidth();
  const [modalWidth, onModalLayout] = useWidth();
  const entry = item.entries[Math.min(index, item.entries.length - 1)];
  const aspect = entry.width && entry.height ? entry.height / entry.width : 0.75;
  // Wide images get fewer, wider columns so their detail stays visible.
  const target = compact ? width : aspect < 0.5 ? 520 : 260;
  const columns = Math.max(1, Math.floor((width + 10) / (target + 10)));
  const tile = Math.floor((width - 10 * (columns - 1)) / columns);
  const files = all ? entry.files : entry.files.slice(0, IMAGES_PER_STEP);
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };
  return (
    <Card theme={theme} title={item.key} detail={`${entry.files.length} ${entry.files.length === 1 ? "image" : "images"}${entry.width ? ` · ${entry.width}×${entry.height}` : ""}`}>
      <StepPicker theme={theme} entries={item.entries} index={index} onChange={setIndex} />
      <View onLayout={onLayout} style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {width > 0
          ? files.map((path, position) => (
              <MediaImage key={path} theme={theme} run={run} path={path} width={tile} aspect={aspect} maxHeight={TILE_HEIGHT} caption={entry.captions[position]} onPress={() => setOpen(position)} />
            ))
          : null}
      </View>
      {entry.files.length > IMAGES_PER_STEP ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(!all)}>
          <Text style={link}>{all ? "Show fewer" : `Show all ${entry.files.length}`}</Text>
        </Pressable>
      ) : null}
      <Modal title={open !== null ? (entry.captions[open] ?? `${item.key} ${open + 1}`) : item.key} open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <Modal.Content>
          {open !== null ? (
            <View onLayout={onModalLayout} style={{ gap: 10 }}>
              {modalWidth > 0 ? <MediaImage theme={theme} run={run} path={entry.files[open]} width={modalWidth} aspect={aspect} /> : null}
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Pressable accessibilityRole="button" accessibilityLabel="Previous image" disabled={open === 0} onPress={() => setOpen(open - 1)}>
                  <Text style={{ ...link, opacity: open === 0 ? 0.4 : 1 }}>‹ Previous</Text>
                </Pressable>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
                  {open + 1} of {entry.files.length}
                  {entry.step !== null ? ` · step ${formatValue(entry.step)}` : ""}
                </Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Next image" disabled={open >= entry.files.length - 1} onPress={() => setOpen(open + 1)}>
                  <Text style={{ ...link, opacity: open >= entry.files.length - 1 ? 0.4 : 1 }}>Next ›</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </Modal.Content>
      </Modal>
    </Card>
  );
}

const cellText = (cell: TableCell) =>
  cell === null ? "—" : typeof cell === "number" ? String(Number(cell.toPrecision(6))) : typeof cell === "object" ? "" : String(cell);

function compareCells(a: TableCell, b: TableCell): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === null || typeof a === "object") return 1;
  if (b === null || typeof b === "object") return -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** A logged table: sortable by any column, filterable, with image cells as thumbnails. */
function TableGrid({ theme, run, path }: { theme: PluginTheme; run: WandbRun; path: string }) {
  const file = useMediaFile(run, path);
  const [sort, setSort] = useState<{ column: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(TABLE_PAGE);
  const rows = useMemo(() => {
    if (file.data?.kind !== "table") return [];
    const matches = metricMatcher(filter);
    const kept = filter.trim() ? file.data.rows.filter((row) => row.some((cell) => matches(cellText(cell)))) : file.data.rows;
    if (!sort) return kept;
    return [...kept].sort((a, b) => compareCells(a[sort.column], b[sort.column]) * (sort.desc ? -1 : 1));
  }, [file.data, filter, sort]);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (file.isPending) return <View style={{ height: 80 }}><Loading /></View>;
  if (file.data?.kind !== "table") return <Text style={muted}>{file.data?.kind === "unavailable" ? file.data.reason : (file.error?.message ?? "Not a table")}</Text>;
  const { columns, total } = file.data;
  const cell = { width: CELL_WIDTH, paddingVertical: 5, paddingHorizontal: 8 };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <Field theme={theme} label="Filter rows" placeholder="Filter rows (regex)" value={filter} onChange={setFilter} width={240} />
        <Text style={muted}>
          {rows.length} of {total} rows{total > file.data.rows.length ? ` (first ${file.data.rows.length} loaded)` : ""} · press a column to sort
        </Text>
      </View>
      <ScrollView horizontal style={{ flexGrow: 0 }}>
        <View style={{ width: CELL_WIDTH * columns.length, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface2 }}>
            {columns.map((column, index) => (
              <Pressable
                key={`${column}-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Sort by ${column}`}
                onPress={() => setSort(sort?.column === index ? { column: index, desc: !sort.desc } : { column: index, desc: false })}
                style={cell}
              >
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600" }}>
                  {column}
                  {sort?.column === index ? (sort.desc ? " ↓" : " ↑") : ""}
                </Text>
              </Pressable>
            ))}
          </View>
          {rows.slice(0, limit).map((row, rowIndex) => (
            <View key={rowIndex} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.colors.border }}>
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex] ?? null;
                return (
                  <View key={columnIndex} style={cell}>
                    {value !== null && typeof value === "object" ? (
                      <MediaImage theme={theme} run={run} path={value.image} width={CELL_WIDTH - 16} aspect={0.75} />
                    ) : (
                      <Text selectable numberOfLines={3} style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>
                        {cellText(value)}
                      </Text>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      {rows.length > limit ? (
        <Pressable accessibilityRole="button" onPress={() => setLimit(limit + TABLE_PAGE)}>
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Show {Math.min(TABLE_PAGE, rows.length - limit)} more rows</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function TableItem({ theme, run, item }: { theme: PluginTheme; run: WandbRun; item: MediaItem }) {
  const [index, setIndex] = useState(item.entries.length - 1);
  const [open, setOpen] = useState(false);
  const entry = item.entries[Math.min(index, item.entries.length - 1)];
  const size = entry.rows !== null ? `${entry.rows} rows × ${entry.cols} columns` : null;
  return (
    <Card theme={theme} title={item.key} detail={size}>
      <StepPicker theme={theme} entries={item.entries} index={index} onChange={setIndex} />
      {open ? <TableGrid key={entry.files[0]} theme={theme} run={run} path={entry.files[0]} /> : null}
      <Pressable accessibilityRole="button" onPress={() => setOpen(!open)}>
        <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>{open ? "Hide table" : "Show table"}</Text>
      </Pressable>
    </Card>
  );
}

const asNumber = (cell: TableCell | undefined) => (typeof cell === "number" ? cell : typeof cell === "string" && cell.trim() !== "" && Number.isFinite(Number(cell)) ? Number(cell) : null);

function Bars({ theme, width, bars }: { theme: PluginTheme; width: number; bars: { label: string; value: number; color: string }[] }) {
  const low = Math.min(0, ...bars.map((bar) => bar.value));
  const high = Math.max(0, ...bars.map((bar) => bar.value));
  const span = high - low || 1;
  const labelWidth = Math.min(200, Math.max(80, width * 0.3));
  const track = Math.max(40, width - labelWidth - 80);
  // Bars grow from zero, so negative values extend left of it.
  const zero = ((0 - low) / span) * track;
  return (
    <View style={{ gap: 4 }}>
      {bars.map((bar, index) => {
        const end = ((bar.value - low) / span) * track;
        return (
          <View key={`${bar.label}-${index}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text numberOfLines={1} style={{ width: labelWidth, color: theme.colors.foregroundMuted, fontSize: 11 }}>
              {bar.label}
            </Text>
            <View style={{ width: track, height: 12 }}>
              <View style={{ position: "absolute", left: zero, top: -2, bottom: -2, width: 1, backgroundColor: theme.colors.border }} />
              <View style={{ position: "absolute", left: Math.min(zero, end), width: Math.max(1, Math.abs(end - zero)), height: 12, borderRadius: 2, backgroundColor: bar.color }} />
            </View>
            <Text style={{ width: 64, color: theme.colors.foreground, fontSize: 11, fontVariant: ["tabular-nums"] }}>{formatValue(bar.value)}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** Equal-width bins over the values, for histograms of a table column. */
function binned(values: number[], count = 20): { bins: number[]; values: number[] } {
  const range = extent(values) ?? { min: 0, max: 1 };
  const width = (range.max - range.min || 1) / count;
  const counts = new Array(count).fill(0);
  for (const value of values) counts[Math.min(count - 1, Math.floor((value - range.min) / width))]++;
  return { bins: Array.from({ length: count + 1 }, (_, index) => range.min + index * width), values: counts };
}

function HistogramBars({ theme, width, histogram }: { theme: PluginTheme; width: number; histogram: { bins: number[]; values: number[] } }) {
  const peak = Math.max(1, ...histogram.values);
  const barWidth = Math.max(1, width / Math.max(1, histogram.values.length) - 1);
  const first = histogram.bins[0];
  const last = histogram.bins[histogram.bins.length - 1];
  const [low, high] = first !== undefined && last !== undefined ? formatPair(first, last) : ["", ""];
  return (
    <View style={{ gap: 4 }}>
      <View style={{ height: PLOT_HEIGHT, width, flexDirection: "row", alignItems: "flex-end", gap: 1 }}>
        {histogram.values.map((value, index) => (
          <View key={index} style={{ width: barWidth, height: Math.max(1, (value / peak) * PLOT_HEIGHT), backgroundColor: theme.colors.accent, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
        ))}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{low}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>peak {formatValue(peak)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>{high}</Text>
      </View>
    </View>
  );
}

/**
 * A custom chart (wandb.plot.*) drawn from its table with the preset's field mapping. Presets
 * without a native drawing show the table.
 */
function ChartItem({ theme, run, item }: { theme: PluginTheme; run: WandbRun; item: MediaItem }) {
  const entry = item.entries[item.entries.length - 1];
  const file = useMediaFile(run, entry.files[0] ?? null);
  const [width, onLayout] = useWidth();
  const fields = item.chart?.fields ?? {};
  const preset = item.type.replace(/^wandb\//, "").replace(/\/v\d+$/, "");
  const content = useMemo(() => {
    if (file.data?.kind !== "table" || width <= 0) return null;
    const { columns, rows } = file.data;
    const column = (field: string) => columns.indexOf(fields[field] ?? "");
    if (preset === "bar" && column("label") >= 0 && column("value") >= 0) {
      const bars = rows.flatMap((row) => {
        const value = asNumber(row[column("value")]);
        return value === null ? [] : [{ label: cellText(row[column("label")]), value, color: theme.colors.accent }];
      });
      return <Bars theme={theme} width={width} bars={bars} />;
    }
    if ((preset === "line" || preset === "area-under-curve" || preset === "scatter") && column("x") >= 0 && column("y") >= 0) {
      // Lines split by the stroke or class column when the preset has one.
      const by = column("stroke") >= 0 ? column("stroke") : column("class") >= 0 ? column("class") : -1;
      const groups = new Map<string, { x: number; y: number }[]>();
      for (const row of rows) {
        const x = asNumber(row[column("x")]);
        const y = asNumber(row[column("y")]);
        if (x === null || y === null) continue;
        const name = by >= 0 ? cellText(row[by]) : fields.y;
        groups.set(name, [...(groups.get(name) ?? []), { x, y }]);
      }
      const lines: ChartLine[] = [...groups.entries()].slice(0, 8).map(([name, points], index) => ({
        id: name,
        label: name,
        color: seriesColor(theme, index),
        points: preset === "scatter" ? points : points.sort((a, b) => a.x - b.x),
      }));
      return <ChartCard theme={theme} title={`${fields.y} vs ${fields.x}`} lines={lines} width={width} xAxis="step" customX={fields.x} logY={false} ignoreOutliers={false} segmentsPerLine={Math.ceil(width / 4)} />;
    }
    if (preset === "histogram" && column("value") >= 0) {
      const values = rows.map((row) => asNumber(row[column("value")])).filter((value): value is number => value !== null);
      return <HistogramBars theme={theme} width={width} histogram={binned(values)} />;
    }
    return null;
  }, [file.data, width, fields, preset, theme]);
  return (
    <Card theme={theme} title={item.chart?.title ?? item.key} detail={`${preset} chart · ${item.key}`}>
      <View onLayout={onLayout}>
        {file.isPending ? (
          <View style={{ height: 80 }}>
            <Loading />
          </View>
        ) : content ? (
          content
        ) : file.data?.kind === "table" ? (
          <TableGrid theme={theme} run={run} path={entry.files[0]} />
        ) : (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{file.data?.kind === "unavailable" ? file.data.reason : (file.error?.message ?? "")}</Text>
        )}
      </View>
    </Card>
  );
}

function HistogramItem({ theme, item }: { theme: PluginTheme; item: MediaItem }) {
  const [index, setIndex] = useState(item.entries.length - 1);
  const [width, onLayout] = useWidth();
  const entry = item.entries[Math.min(index, item.entries.length - 1)];
  return (
    <Card theme={theme} title={item.key} detail="histogram">
      <StepPicker theme={theme} entries={item.entries} index={index} onChange={setIndex} />
      <View onLayout={onLayout}>{width > 0 && entry.histogram ? <HistogramBars theme={theme} width={width} histogram={entry.histogram} /> : null}</View>
    </Card>
  );
}

const SECTIONS: { kind: MediaItem["kind"][]; title: string }[] = [
  { kind: ["chart"], title: "Custom charts" },
  { kind: ["images"], title: "Images" },
  { kind: ["table"], title: "Tables" },
  { kind: ["histogram"], title: "Histograms" },
  { kind: ["video", "audio", "html", "other"], title: "Other media" },
];

/** A run's logged media: images, tables, custom charts, and histograms, drawn here where possible. */
export function MediaView({ theme, compact, run }: { theme: PluginTheme; compact: boolean; run: WandbRun }) {
  const index = useMediaIndex(run);
  const [filter, setFilter] = useState("");
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  if (index.isPending) return <View style={{ height: 120 }}><Loading /></View>;
  if (index.error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Could not load media: {index.error.message}</Text>;
  const matches = metricMatcher(filter);
  const items = index.data.items.filter((item) => matches(item.key));
  if (index.data.items.length === 0) return <Text style={muted}>This run has logged no images, tables, custom charts, or other media.</Text>;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <Field theme={theme} label="Filter media" placeholder="Filter media keys (regex)" value={filter} onChange={setFilter} width={compact ? undefined : 240} />
        <Text style={muted}>
          {items.length} of {index.data.items.length} media keys
          {index.data.omitted ? `; ${index.data.omitted} more only in W&B` : ""}
        </Text>
        {index.isFetching ? <Text style={muted}>Updating…</Text> : null}
      </View>
      {SECTIONS.map((section) => {
        const members = items.filter((item) => section.kind.includes(item.kind));
        if (members.length === 0) return null;
        return (
          <View key={section.title} style={{ gap: 10 }}>
            <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
              {section.title} <Text style={muted}>{members.length}</Text>
            </Text>
            {members.map((item) => {
              switch (item.kind) {
                case "images":
                  return <ImagesItem key={item.key} theme={theme} run={run} item={item} compact={compact} />;
                case "table":
                  return <TableItem key={item.key} theme={theme} run={run} item={item} />;
                case "chart":
                  return <ChartItem key={item.key} theme={theme} run={run} item={item} />;
                case "histogram":
                  return <HistogramItem key={item.key} theme={theme} item={item} />;
                default:
                  return (
                    <Card key={item.key} theme={theme} title={item.key} detail={item.type}>
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                        <Text style={muted}>{item.kind === "video" || item.kind === "audio" ? "Playback" : "This media type"} is not available in Paseo plugins.</Text>
                        <ExternalLink href={run.url} accessibilityLabel={`Open ${run.name} in W&B`}>
                          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Open in W&B</Text>
                        </ExternalLink>
                      </View>
                    </Card>
                  );
              }
            })}
          </View>
        );
      })}
    </View>
  );
}

/** The Media view's run picker and the picked run's media. */
export function MediaPane({
  theme,
  compact,
  runs,
  labels,
  colors,
  selectedKey,
  onSelect,
}: {
  theme: PluginTheme;
  compact: boolean;
  runs: WandbRun[];
  labels: Map<string, string>;
  colors: Map<string, string>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const run = runs.find((candidate) => candidate.key === selectedKey) ?? runs[0];
  return (
    <View style={{ gap: 12 }}>
      {runs.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {runs.map((candidate) => (
            <Chip
              key={candidate.key}
              theme={theme}
              label={labels.get(candidate.key) ?? candidate.name}
              color={colors.get(candidate.key)}
              selected={candidate.key === run.key}
              onPress={() => onSelect(candidate.key)}
              accessibilityLabel={`Show media of ${candidate.name}`}
            />
          ))}
        </View>
      ) : null}
      <MediaView key={run.key} theme={theme} compact={compact} run={run} />
    </View>
  );
}
