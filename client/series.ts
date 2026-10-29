import type { Series } from "../shared/wandb";
import type { XAxis } from "./model";

export interface XY {
  x: number;
  y: number;
}

/** A series' points against the chosen x axis; system metrics fall back to runtime for steps. */
export function toXY(points: Series["points"], axis: XAxis): XY[] {
  const xs = points.map(([step, runtime, wall]) => (axis === "step" ? (step ?? runtime) : axis === "runtime" ? runtime : wall));
  const result: XY[] = [];
  points.forEach((point, index) => {
    const x = xs[index];
    if (x !== null && Number.isFinite(point[3])) result.push({ x, y: point[3] });
  });
  return result.sort((a, b) => a.x - b.x);
}

/**
 * Exponential moving average with TensorBoard's debiasing, so the start of the line is not
 * pulled toward zero. A weight of 0 returns the points unchanged.
 */
export function smooth(points: XY[], weight: number): XY[] {
  if (weight <= 0 || points.length < 3) return points;
  let last = 0;
  let count = 0;
  return points.map(({ x, y }) => {
    last = last * weight + (1 - weight) * y;
    count++;
    return { x, y: last / (1 - weight ** count) };
  });
}

/** log10 of the positive values; others cannot be drawn on a log scale. */
export const toLog = (points: XY[]) => points.filter((point) => point.y > 0).map(({ x, y }) => ({ x, y: Math.log10(y) }));

function interpolate(points: XY[], x: number): number | null {
  if (points.length === 0 || x < points[0].x || x > points[points.length - 1].x) return null;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].x <= x) low = middle;
    else high = middle;
  }
  const a = points[low];
  const b = points[high];
  if (b.x === a.x) return a.y;
  return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
}

/** Mean, minimum, and maximum of several runs on a shared x grid, where at least one has data. */
export function aggregate(members: XY[][], buckets = 160): { mean: XY[]; min: XY[]; max: XY[] } {
  const present = members.filter((points) => points.length > 0);
  const mean: XY[] = [];
  const min: XY[] = [];
  const max: XY[] = [];
  if (present.length === 0) return { mean, min, max };
  const start = Math.min(...present.map((points) => points[0].x));
  const end = Math.max(...present.map((points) => points[points.length - 1].x));
  const count = end === start ? 1 : buckets;
  for (let index = 0; index < count; index++) {
    const x = count === 1 ? start : start + ((end - start) * index) / (count - 1);
    const values = present.map((points) => interpolate(points, x)).filter((value): value is number => value !== null);
    if (values.length === 0) continue;
    mean.push({ x, y: values.reduce((sum, value) => sum + value, 0) / values.length });
    min.push({ x, y: Math.min(...values) });
    max.push({ x, y: Math.max(...values) });
  }
  return { mean, min, max };
}

/** The point whose x is closest to `x`, by binary search over x-sorted points. */
export function nearest(points: XY[], x: number): XY | null {
  if (points.length === 0) return null;
  let low = 0;
  let high = points.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (points[middle].x <= x) low = middle;
    else high = middle;
  }
  return Math.abs(points[low].x - x) <= Math.abs(points[high].x - x) ? points[low] : points[high];
}

/** Keeps the lowest and highest point of each bucket so spikes survive thinning. */
export function thin(points: XY[], limit: number): XY[] {
  if (points.length <= limit) return points;
  const buckets = Math.max(1, Math.floor(limit / 2));
  const size = points.length / buckets;
  const kept: XY[] = [];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = Math.floor(bucket * size);
    const end = Math.floor((bucket + 1) * size);
    if (end <= start) continue;
    let low = points[start];
    let high = points[start];
    for (let index = start; index < end; index++) {
      if (points[index].y < low.y) low = points[index];
      if (points[index].y > high.y) high = points[index];
    }
    if (low === high) kept.push(low);
    else kept.push(...(low.x <= high.x ? [low, high] : [high, low]));
  }
  const last = points[points.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

export function extent(values: number[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/** Metric names matching the search: as a case-insensitive regular expression, or as plain text if it is not one. */
export function metricMatcher(search: string): (key: string) => boolean {
  const text = search.trim();
  if (!text) return () => true;
  try {
    const pattern = new RegExp(text, "i");
    return (key) => pattern.test(key);
  } catch {
    const lower = text.toLowerCase();
    return (key) => key.toLowerCase().includes(lower);
  }
}
