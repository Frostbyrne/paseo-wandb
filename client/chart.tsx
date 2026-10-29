import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import type { Series } from "../shared/wandb";
import { formatValue } from "./state";

/**
 * Charts are drawn with plain views, one rotated hairline per segment. Plugin code cannot import
 * react-native-svg, and the host caches every distinct inline SVG icon, so charts that redraw on
 * each poll would pile up there.
 */

const LINE_WIDTH = 1.5;
const PLOT_HEIGHT = 110;
/** Pixels per drawn segment; fewer segments keep large grids cheap. */
const PIXELS_PER_POINT = 4;

type Point = [number, number];

/** Keeps the lowest and highest point of each bucket so spikes survive thinning. */
function thin(points: Point[], limit: number): Point[] {
  if (points.length <= limit) return points;
  const buckets = Math.max(1, Math.floor(limit / 2));
  const size = points.length / buckets;
  const kept: Point[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const slice = points.slice(Math.floor(bucket * size), Math.floor((bucket + 1) * size));
    if (slice.length === 0) continue;
    let low = slice[0];
    let high = slice[0];
    for (const point of slice) {
      if (point[1] < low[1]) low = point;
      if (point[1] > high[1]) high = point;
    }
    if (low === high) kept.push(low);
    else kept.push(...(low[0] <= high[0] ? [low, high] : [high, low]));
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

function extent(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

/** The data's extent plus a little headroom, so the line does not touch the plot's edges. */
function range(values: number[]): { min: number; max: number } {
  const { min, max } = extent(values);
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
}

/** A polyline of absolutely positioned segments filling a `width` × `height` box. */
function Polyline({ points, width, height, color }: { points: Point[]; width: number; height: number; color: string }) {
  const segments = useMemo(() => {
    if (points.length === 0 || width <= 0) return [];
    const xs = extent(points.map((point) => point[0]));
    const ys = range(points.map((point) => point[1]));
    const toX = (x: number) => (xs.max === xs.min ? width / 2 : ((x - xs.min) / (xs.max - xs.min)) * width);
    const toY = (y: number) => height - ((y - ys.min) / (ys.max - ys.min)) * height;
    const pixels = points.map(([x, y]) => [toX(x), toY(y)] as const);
    if (pixels.length === 1) {
      const [x, y] = pixels[0];
      return [{ left: x - 2, top: y - 2, width: 4, height: 4, borderRadius: 2, rotate: "0rad" }];
    }
    return pixels.slice(1).map(([x2, y2], index) => {
      const [x1, y1] = pixels[index];
      // Half a line width of overlap closes the gaps at the joints.
      const length = Math.hypot(x2 - x1, y2 - y1) + LINE_WIDTH / 2;
      return {
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - LINE_WIDTH / 2,
        width: length,
        height: LINE_WIDTH,
        borderRadius: LINE_WIDTH / 2,
        rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad`,
      };
    });
  }, [points, width, height]);
  return (
    <>
      {segments.map(({ rotate, ...box }, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={{ position: "absolute", ...box, backgroundColor: color, transform: [{ rotate }] }}
        />
      ))}
    </>
  );
}

export function Sparkline({ values, width, height, color }: { values: number[]; width: number; height: number; color: string }) {
  const points = useMemo(() => thin(values.map((value, index) => [index, value] as Point), Math.ceil(width / 3)), [values, width]);
  return (
    <View style={{ width, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Polyline points={points} width={width} height={height} color={color} />
    </View>
  );
}

function ChartCard({ theme, series, width }: { theme: PluginTheme; series: Series; width: number }) {
  const plotWidth = Math.max(0, width - 22);
  const points = useMemo(() => thin(series.points, Math.ceil(plotWidth / PIXELS_PER_POINT)), [series.points, plotWidth]);
  const values = series.points.map((point) => point[1]);
  const ys = values.length ? extent(values) : null;
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  const muted = { color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums" as const] };
  const grid = { position: "absolute" as const, left: 0, right: 0, height: 1, backgroundColor: theme.colors.border, opacity: 0.6 };
  // Axis labels sit over the line, so they get the card's background to stay readable.
  const label = { position: "absolute" as const, left: 0, paddingHorizontal: 2, borderRadius: 3, backgroundColor: theme.colors.surface1 };
  return (
    <View
      style={{
        width,
        padding: 10,
        gap: 6,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
      accessible
      accessibilityLabel={
        last ? `${series.key}: latest ${formatValue(last[1])} at ${series.xLabel} ${formatValue(last[0])}` : `${series.key}: no data`
      }
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
          {series.key}
        </Text>
        {last ? (
          <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{formatValue(last[1])}</Text>
        ) : null}
      </View>
      <View style={{ height: PLOT_HEIGHT, width: plotWidth }}>
        <View style={{ ...grid, top: 0 }} />
        <View style={{ ...grid, top: PLOT_HEIGHT / 2 }} />
        <View style={{ ...grid, top: PLOT_HEIGHT - 1 }} />
        {points.length > 0 ? (
          <Polyline points={points} width={plotWidth} height={PLOT_HEIGHT} color={theme.colors.accent} />
        ) : (
          <Text style={{ ...muted, fontSize: 12, paddingTop: PLOT_HEIGHT / 2 - 8, textAlign: "center" }}>No data yet</Text>
        )}
        {ys ? (
          <>
            <Text style={{ ...muted, ...label, top: 1 }}>{formatValue(ys.max)}</Text>
            <Text style={{ ...muted, ...label, bottom: 1 }}>{formatValue(ys.min)}</Text>
          </>
        ) : null}
      </View>
      {first && last ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={muted}>
            {series.xLabel} {formatValue(first[0])}
          </Text>
          <Text style={muted}>{formatValue(last[0])}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Charts in as many columns as the width allows. */
export function ChartGrid({ theme, series, compact }: { theme: PluginTheme; series: Series[]; compact: boolean }) {
  const [width, setWidth] = useState(0);
  const gap = 10;
  const columns = compact ? 1 : width >= 1100 ? 3 : width >= 620 ? 2 : 1;
  const cardWidth = Math.floor((width - gap * (columns - 1)) / columns);
  return (
    <View
      onLayout={(event: LayoutChangeEvent) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      style={{ flexDirection: "row", flexWrap: "wrap", gap }}
    >
      {width > 0 ? series.map((entry) => <ChartCard key={entry.key} theme={theme} series={entry} width={cardWidth} />) : null}
    </View>
  );
}
