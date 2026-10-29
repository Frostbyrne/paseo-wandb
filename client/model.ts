import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { z } from "zod";

/** Categorical series colors, in a fixed order validated for color-vision deficiency in both modes. */
const LIGHT_SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const DARK_SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Runs compared at once; more cannot be told apart by color. */
export const MAX_SELECTED = LIGHT_SERIES.length;

function luminance(color: string): number | null {
  let rgb: number[] | null = null;
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})/i);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    rgb = [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16));
  } else {
    const functional = color.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (functional) rgb = functional.slice(1, 4).map(Number);
  }
  if (!rgb) return null;
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The theme has no light or dark flag, so the background decides. */
export const isDark = (theme: PluginTheme) => (luminance(theme.colors.surface0) ?? 1) < 0.3;

export const seriesColor = (theme: PluginTheme, slot: number) => (isDark(theme) ? DARK_SERIES : LIGHT_SERIES)[slot % MAX_SELECTED];

/** A run picked for comparison and the color slot it keeps while picked. */
export const selectionSchema = z.array(z.object({ key: z.string(), slot: z.number().int().min(0).max(MAX_SELECTED - 1) }));
export type Selection = z.infer<typeof selectionSchema>;

/** Adds the run with the lowest free color, or removes it; full selections ignore additions. */
export function toggleSelection(selection: Selection, key: string): Selection {
  if (selection.some((entry) => entry.key === key)) return selection.filter((entry) => entry.key !== key);
  if (selection.length >= MAX_SELECTED) return selection;
  const used = new Set(selection.map((entry) => entry.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  return [...selection, { key, slot }];
}

/** Run names for legends and chips, with the run ID added where two runs share a name. */
export function runLabels(runs: { key: string; name: string; id: string }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
  return new Map(runs.map((run) => [run.key, (counts.get(run.name) ?? 0) > 1 ? `${run.name} · ${run.id}` : run.name]));
}

export function selectionOf(keys: string[]): Selection {
  return keys.slice(0, MAX_SELECTED).map((key, slot) => ({ key, slot }));
}

export const xAxisSchema = z.enum(["step", "runtime", "wall"]);
export type XAxis = z.infer<typeof xAxisSchema>;

export const prefsSchema = z.object({
  view: z.enum(["charts", "logs", "table"]),
  /** Exponential moving average weight, 0 to 0.99. */
  smoothing: z.number().min(0).max(0.99),
  xAxis: xAxisSchema,
  logY: z.boolean(),
  /** Metric names to show; a case-insensitive regular expression or plain text. */
  search: z.string(),
  /** "", "group", "jobType", or "config.<key>". */
  groupBy: z.string(),
  /** Compare table: hide rows where every run agrees. */
  diffOnly: z.boolean(),
  /** Show only the last this-many x units (steps or seconds), following new data; null shows everything. */
  window: z.number().positive().nullable().default(null),
  /** Scale the y axis to the 5th–95th percentile so early spikes do not flatten the rest. */
  ignoreOutliers: z.boolean().default(false),
});
export type ChartPrefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: ChartPrefs = {
  view: "charts",
  smoothing: 0,
  xAxis: "step",
  logY: false,
  search: "",
  groupBy: "",
  diffOnly: true,
  window: null,
  ignoreOutliers: false,
};

// Screens remount when you navigate away and back; this keeps their state for the session.
const memory = new Map<string, unknown>();

export function useRemembered<T>(key: string, initial: T | (() => T)): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() =>
    memory.has(key) ? (memory.get(key) as T) : typeof initial === "function" ? (initial as () => T)() : initial,
  );
  return [
    value,
    (next: T) => {
      memory.set(key, next);
      setValue(next);
    },
  ];
}
