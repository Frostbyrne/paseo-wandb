import type { PluginTheme } from "@getpaseo/plugin";
import { memo, type ReactNode, useMemo, useState } from "react";
import { type GestureResponderEvent, type LayoutChangeEvent, Text, View } from "react-native";
import { LineKey } from "./controls";
import type { Dash, XAxis } from "./model";
import { extent, nearest, thin, type XY } from "./series";
import { formatPair, formatValue } from "./state";

/**
 * Charts are drawn with plain views, one rotated hairline per segment. Plugin code cannot import
 * react-native-svg, and the host caches every distinct inline SVG icon, so charts that redraw on
 * each poll would pile up there.
 */

export const PLOT_HEIGHT = 120;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A polyline of absolutely positioned segments filling a `width` × `height` box. */
export const Polyline = memo(function Polyline({
  points,
  width,
  height,
  color,
  xRange,
  yRange,
  lineWidth = 1.5,
  opacity = 1,
  dash = "solid",
}: {
  points: XY[];
  width: number;
  height: number;
  color: string;
  xRange: { min: number; max: number };
  yRange: { min: number; max: number };
  lineWidth?: number;
  opacity?: number;
  dash?: Dash;
}) {
  const segments = useMemo(() => {
    if (points.length === 0 || width <= 0) return [];
    const toX = (x: number) => (xRange.max === xRange.min ? width / 2 : ((x - xRange.min) / (xRange.max - xRange.min)) * width);
    const toY = (y: number) => height - ((y - yRange.min) / (yRange.max - yRange.min)) * height;
    const pixels = points.map(({ x, y }) => [toX(x), toY(y)] as const);
    if (pixels.length === 1) {
      const [x, y] = pixels[0];
      return [{ left: x - 2, top: y - 2, width: 4, height: 4, borderRadius: 2, rotate: "0rad" }];
    }
    const piece = (x1: number, y1: number, x2: number, y2: number, overlap: number) => {
      const length = Math.hypot(x2 - x1, y2 - y1) + overlap;
      return {
        left: (x1 + x2) / 2 - length / 2,
        top: (y1 + y2) / 2 - lineWidth / 2,
        width: length,
        height: lineWidth,
        borderRadius: lineWidth / 2,
        rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad`,
      };
    };
    if (dash === "solid") {
      // Half a line width of overlap closes the gaps at the joints.
      return pixels.slice(1).map(([x2, y2], index) => piece(pixels[index][0], pixels[index][1], x2, y2, lineWidth / 2));
    }
    // Dashes follow the line's length across joints, so the pattern stays even on bends.
    const [on, off] = dash === "dashed" ? [6, 4] : [lineWidth, 3];
    const pieces: ReturnType<typeof piece>[] = [];
    let phase = 0;
    for (let index = 1; index < pixels.length; index++) {
      const [x1, y1] = pixels[index - 1];
      const [x2, y2] = pixels[index];
      const length = Math.hypot(x2 - x1, y2 - y1);
      let along = 0;
      while (along < length) {
        const position = phase % (on + off);
        const step = Math.min(position < on ? on - position : on + off - position, length - along);
        if (position < on && step > 0.2) {
          const from = along / length;
          const to = (along + step) / length;
          pieces.push(piece(x1 + (x2 - x1) * from, y1 + (y2 - y1) * from, x1 + (x2 - x1) * to, y1 + (y2 - y1) * to, 0));
        }
        along += step;
        phase += step;
      }
    }
    return pieces;
  }, [points, width, height, xRange.min, xRange.max, yRange.min, yRange.max, lineWidth, dash]);
  return (
    <>
      {segments.map(({ rotate, ...box }, index) => (
        <View
          key={index}
          pointerEvents="none"
          style={{ position: "absolute", ...box, opacity, backgroundColor: color, transform: [{ rotate }] }}
        />
      ))}
    </>
  );
});

export const padRange = ({ min, max }: { min: number; max: number }) => {
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.06;
  return { min: min - pad, max: max + pad };
};

export function Sparkline({ values, width, height, color }: { values: number[]; width: number; height: number; color: string }) {
  const points = useMemo(() => thin(values.map((y, x) => ({ x, y })), Math.ceil(width / 3)), [values, width]);
  const xRange = { min: 0, max: Math.max(1, values.length - 1) };
  const yRange = padRange(extent(values) ?? { min: 0, max: 1 });
  return (
    <View style={{ width, height }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Polyline points={points} width={width} height={height} color={color} xRange={xRange} yRange={yRange} />
    </View>
  );
}

const pad2 = (value: number) => String(value).padStart(2, "0");

export function formatX(value: number, axis: XAxis, span: number): string {
  // Grouped runs are averaged on a shared grid, so steps can come out fractional.
  if (axis === "step") return formatValue(Math.abs(value) >= 1 ? Math.round(value) : value);
  if (axis === "runtime") {
    if (span < 120) return `${Math.round(value)}s`;
    if (span < 7200) return `${Math.round(value / 60)}m`;
    const hours = Math.floor(value / 3600);
    return `${hours}h ${pad2(Math.floor((value % 3600) / 60))}m`;
  }
  const date = new Date(value * 1000);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return span < 86_400 ? time : `${MONTHS[date.getMonth()]} ${date.getDate()} ${time}`;
}

export const X_AXIS_LABEL: Record<XAxis, string> = { step: "step", runtime: "time", wall: "" };

/** One drawn line. `id` lines with the same label share a tooltip row; faint lines get none. */
export interface ChartLine {
  id: string;
  label: string;
  color: string;
  /** Full-resolution points for the tooltip; drawing thins them. */
  points: XY[];
  faint?: boolean;
  dash?: Dash;
  /** Drawn faded behind the rest while another run is highlighted. */
  dim?: boolean;
}

/** Tooltip rows beyond this are summarized; the highlighted run is always listed. */
const TOOLTIP_ROWS = 10;

/** The 5th to 95th percentile of the values, like W&B's "ignore outliers"; the full extent for few points. */
function robustExtent(values: number[]): { min: number; max: number } | null {
  if (values.length < 20) return extent(values);
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
  return { min: at(0.05), max: at(0.95) };
}

function ChartCardImpl({
  theme,
  title,
  lines,
  width,
  xAxis,
  logY,
  ignoreOutliers,
  segmentsPerLine,
  customX = null,
}: {
  theme: PluginTheme;
  title: string;
  lines: ChartLine[];
  width: number;
  xAxis: XAxis;
  logY: boolean;
  ignoreOutliers: boolean;
  segmentsPerLine: number;
  /** A metric plotted as x instead of steps or time; its values are shown as numbers. */
  customX?: string | null;
}) {
  const plotWidth = Math.max(0, width - 22);
  const [hover, setHover] = useState<number | null>(null);
  // Faded lines go first so highlighted and normal ones draw on top of them.
  const drawn = useMemo(
    () => [...lines].sort((a, b) => Number(Boolean(b.dim)) - Number(Boolean(a.dim))).map((line) => ({ ...line, points: thin(line.points, segmentsPerLine) })),
    [lines, segmentsPerLine],
  );
  const xs = useMemo(() => extent(lines.flatMap((line) => [line.points[0]?.x, line.points[line.points.length - 1]?.x].filter((x): x is number => x !== undefined))), [lines]);
  const ys = useMemo(() => {
    const values = lines.flatMap((line) => line.points.map((point) => point.y));
    return ignoreOutliers ? robustExtent(lines.filter((line) => !line.faint).flatMap((line) => line.points.map((point) => point.y))) : extent(values);
  }, [lines, ignoreOutliers]);
  const yRange = padRange(ys ?? { min: 0, max: 1 });
  const xRange = xs ?? { min: 0, max: 1 };
  const span = xRange.max - xRange.min;
  const showY = (value: number) => formatValue(logY ? 10 ** value : value);
  const yLabels = ys ? formatPair(logY ? 10 ** ys.min : ys.min, logY ? 10 ** ys.max : ys.max) : ["", ""];
  const xName = customX ?? X_AXIS_LABEL[xAxis];
  const showX = (value: number) => (customX ? formatValue(value) : formatX(value, xAxis, span));
  const solid = lines.filter((line) => !line.faint);
  const single = solid.length === 1 ? solid[0].points[solid[0].points.length - 1] : null;

  // The crosshair snaps to the nearest logged x of any line, then reads every line there.
  const readout = useMemo(() => {
    if (hover === null || !xs || plotWidth <= 0) return null;
    const target = xRange.max === xRange.min ? xRange.min : xRange.min + (hover / plotWidth) * (xRange.max - xRange.min);
    let snapped: number | null = null;
    for (const line of solid) {
      const point = nearest(line.points, target);
      if (point && (snapped === null || Math.abs(point.x - target) < Math.abs(snapped - target))) snapped = point.x;
    }
    if (snapped === null) return null;
    const rows = solid
      .map((line) => ({ line, point: nearest(line.points, snapped!) }))
      .filter((row): row is { line: ChartLine; point: XY } => row.point !== null && Math.abs(row.point.x - snapped!) <= Math.max(span * 0.02, 1e-9))
      .sort((a, b) => Number(Boolean(a.line.dim)) - Number(Boolean(b.line.dim)) || b.point.y - a.point.y);
    const left = xRange.max === xRange.min ? plotWidth / 2 : ((snapped - xRange.min) / (xRange.max - xRange.min)) * plotWidth;
    return { x: snapped, left, rows };
  }, [hover, solid, xs, xRange.min, xRange.max, plotWidth, span]);

  const muted = { color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums" as const] };
  const grid = { position: "absolute" as const, left: 0, right: 0, height: 1, backgroundColor: theme.colors.border, opacity: 0.6 };
  // Axis labels sit over the line, so they get the card's background to stay readable.
  const label = { position: "absolute" as const, left: 0, paddingHorizontal: 2, borderRadius: 3, backgroundColor: theme.colors.surface1 };
  const track = (x: number) => setHover(Math.max(0, Math.min(plotWidth, x)));
  const fromTouch = (event: GestureResponderEvent) => track(event.nativeEvent.locationX);
  const tooltipWidth = 190;

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
        zIndex: readout ? 2 : 0,
      }}
      accessible
      accessibilityLabel={`${title}: ${solid
        .map((line) => {
          const last = line.points[line.points.length - 1];
          return last ? `${line.label} ${showY(last.y)}` : `${line.label} no data`;
        })
        .join(", ")}`}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
          {title}
        </Text>
        {single ? <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{showY(single.y)}</Text> : null}
      </View>
      <View style={{ height: PLOT_HEIGHT, width: plotWidth }}>
        <View style={{ ...grid, top: 0 }} />
        <View style={{ ...grid, top: PLOT_HEIGHT / 2 }} />
        <View style={{ ...grid, top: PLOT_HEIGHT - 1 }} />
        {ys ? (
          // Lines beyond a clipped y range are cut at the plot's edge.
          <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>
            {drawn.map((line) => (
              <Polyline
                key={line.id}
                points={line.points}
                width={plotWidth}
                height={PLOT_HEIGHT}
                color={line.color}
                xRange={xRange}
                yRange={yRange}
                lineWidth={line.faint ? 1 : line.dash === "dotted" ? 2 : 1.5}
                opacity={line.dim ? 0.15 : line.faint ? 0.3 : 1}
                dash={line.dash}
              />
            ))}
          </View>
        ) : (
          <Text style={{ ...muted, fontSize: 12, paddingTop: PLOT_HEIGHT / 2 - 8, textAlign: "center" }}>No data yet</Text>
        )}
        {ys ? (
          <>
            <Text style={{ ...muted, ...label, top: 1 }}>{yLabels[1]}</Text>
            <Text style={{ ...muted, ...label, bottom: 1 }}>{yLabels[0]}</Text>
          </>
        ) : null}
        {readout ? (
          <>
            <View pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, left: readout.left, width: 1, backgroundColor: theme.colors.foregroundMuted }} />
            <View
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 4,
                left: readout.left + 12 + tooltipWidth > plotWidth ? Math.max(0, readout.left - 12 - tooltipWidth) : readout.left + 12,
                width: tooltipWidth,
                padding: 8,
                gap: 3,
                borderRadius: 6,
                borderWidth: 1,
                borderColor: theme.colors.border,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text style={{ ...muted, fontSize: 11 }}>
                {xName} {showX(readout.x)}
              </Text>
              {readout.rows.slice(0, TOOLTIP_ROWS).map(({ line, point }) => (
                <View key={line.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <LineKey color={line.color} dash={line.dash} width={12} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600", fontVariant: ["tabular-nums"] }}>{showY(point.y)}</Text>
                  <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, flexShrink: 1 }}>
                    {line.label}
                  </Text>
                </View>
              ))}
              {readout.rows.length > TOOLTIP_ROWS ? <Text style={{ ...muted, fontSize: 11 }}>+{readout.rows.length - TOOLTIP_ROWS} more</Text> : null}
            </View>
          </>
        ) : null}
        {/* Hover on desktop and the web, press and drag on touch screens. */}
        <View
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          onPointerMove={(event) => track(event.nativeEvent.offsetX)}
          onPointerLeave={() => setHover(null)}
          onStartShouldSetResponder={() => true}
          onResponderGrant={fromTouch}
          onResponderMove={fromTouch}
          onResponderRelease={() => setHover(null)}
          onResponderTerminate={() => setHover(null)}
        />
      </View>
      {xs ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={muted} numberOfLines={1}>
            {xName} {showX(xRange.min)}
          </Text>
          <Text style={muted}>{showX(xRange.max)}</Text>
        </View>
      ) : null}
    </View>
  );
}

export const ChartCard = memo(ChartCardImpl);

/** Charts in as many columns as the width allows. */
export function ChartGrid({ compact, children }: { compact: boolean; children: (cardWidth: number) => ReactNode }) {
  const [width, setWidth] = useState(0);
  const gap = 10;
  const columns = compact ? 1 : width >= 1100 ? 3 : width >= 620 ? 2 : 1;
  const cardWidth = Math.floor((width - gap * (columns - 1)) / columns);
  return (
    <View
      onLayout={(event: LayoutChangeEvent) => setWidth(Math.floor(event.nativeEvent.layout.width))}
      style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", gap }}
    >
      {width > 0 ? children(cardWidth) : null}
    </View>
  );
}
