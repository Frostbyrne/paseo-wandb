import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isActive, isLive, type RunState, runsByKeyRpc, type WandbRun, type WandbStatus, wandbStatusRpc } from "../shared/wandb";

const STATUS_KEY = ["wandb-status"] as const;
const POLL_MS = 30_000;
/** A running run with no heartbeat for this long is probably stuck or gone. */
export const STALE_HEARTBEAT_MS = 5 * 60_000;
/** Crashed and failed runs keep the sidebar dot red this long. */
const FAILURE_ALERT_MS = 30 * 60_000;

export function useWandbStatus() {
  const fetchStatus = useRpc(wandbStatusRpc);
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => fetchStatus({}),
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    retry: 1,
  });
}

/** Bypasses the daemon's short cache. */
export function useRefreshWandb() {
  const fetchStatus = useRpc(wandbStatusRpc);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => fetchStatus({ refresh: true }),
    onSuccess: (status) => queryClient.setQueryData(STATUS_KEY, status),
  });
}

/** Full rows, with config and summary, for runs picked by key; earlier rows stay up while refetching. */
export function useRunsByKey(keys: string[], anyLive: boolean) {
  const fetchRuns = useRpc(runsByKeyRpc);
  const sorted = [...new Set(keys)].sort();
  return useQuery({
    queryKey: ["wandb-runs-by-key", sorted],
    queryFn: () => fetchRuns({ keys: sorted }),
    enabled: sorted.length > 0,
    placeholderData: keepPreviousData,
    // Live runs refresh as often as their charts; progress, GPU use, and health come from here.
    refetchInterval: anyLive ? 15_000 : false,
    retry: 1,
  });
}

/**
 * Rows from run queries, marked updating where the status poll says so. Only the status poll sees
 * local scripts, so it alone knows which finished runs are still being added to.
 */
export function useStatusLiveness(rows: WandbRun[]): WandbRun[] {
  const { data } = useWandbStatus();
  const live = new Set((data?.runs ?? []).filter((run) => run.updating).map((run) => run.key));
  return rows.map((row) => (live.has(row.key) && !row.updating ? { ...row, updating: true } : row));
}

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

const ENDED_BADLY = new Set<RunState>(["crashed", "failed", "killed", "preempted"]);

export const isStale = (run: WandbRun, now: number) =>
  run.state === "running" && run.heartbeatAt !== null && now - Date.parse(run.heartbeatAt) > STALE_HEARTBEAT_MS;

/** A live run that is heartbeating but in trouble: NaN metrics or no new steps. */
export const isUnhealthy = (run: WandbRun) => isActive(run) && (run.nonFinite.length > 0 || run.stalledSeconds !== null);

export function stateColor(run: WandbRun, theme: PluginTheme, now: number): string {
  if (isActive(run) && run.nonFinite.length > 0) return theme.colors.statusDanger;
  if (isStale(run, now) || run.stalledSeconds !== null) return theme.colors.statusWarning;
  if (run.state === "running" || run.updating) return theme.colors.statusSuccess;
  if (run.state === "pending") return theme.colors.statusWarning;
  if (ENDED_BADLY.has(run.state)) return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export interface Summary {
  active: number;
  /** Finished runs that scripts are still adding to. */
  updating: number;
  /** Local W&B scripts that have logged nothing yet. */
  waiting: number;
  ended: number;
  /** Running runs whose heartbeat stopped or that stopped logging. */
  stale: number;
  /** Running runs logging NaN or infinite metrics. */
  nonFinite: number;
  /** Runs that crashed or failed within the alert window. */
  failedRecently: number;
}

export function summarize(status: WandbStatus, now: number): Summary {
  const active = status.runs.filter(isActive);
  const updating = status.runs.filter((run) => !isActive(run) && run.updating).length;
  return {
    active: active.length,
    updating,
    waiting: status.loggers.filter((logger) => logger.runCount === 0).length,
    ended: status.runs.length - active.length - updating,
    stale: active.filter((run) => isStale(run, now) || run.stalledSeconds !== null).length,
    nonFinite: active.filter((run) => run.nonFinite.length > 0).length,
    failedRecently: status.runs.filter(
      (run) => ENDED_BADLY.has(run.state) && now - Date.parse(run.heartbeatAt ?? run.createdAt) < FAILURE_ALERT_MS,
    ).length,
  };
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function stateText(run: WandbRun, now: number): string {
  if (run.stalledSeconds !== null && !isStale(run, now)) return `running, no new steps for ${duration(run.stalledSeconds)}`;
  if (isStale(run, now)) return `no heartbeat for ${duration((now - Date.parse(run.heartbeatAt!)) / 1000)}`;
  if (run.state === "running") return `running ${duration((now - Date.parse(run.createdAt)) / 1000)}`;
  if (run.state === "pending") return "pending";
  if (run.updating) return `updating, last ${run.heartbeatAt ? `${duration((now - Date.parse(run.heartbeatAt)) / 1000)} ago` : "recently"}`;
  const ended = run.heartbeatAt ? ` ${duration((now - Date.parse(run.heartbeatAt)) / 1000)} ago` : "";
  const took = run.runtime != null ? `, ran ${duration(run.runtime)}` : "";
  return `${run.state}${ended}${took}`;
}

/** Up to four significant digits; compact for large values, scientific for tiny ones. */
export function formatValue(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const magnitude = Math.abs(value);
  if (magnitude === 0) return "0";
  if (magnitude >= 1e15) return value.toExponential(2);
  if (magnitude >= 1e4) {
    const [divisor, suffix] = magnitude >= 1e12 ? [1e12, "T"] : magnitude >= 1e9 ? [1e9, "B"] : magnitude >= 1e6 ? [1e6, "M"] : [1e3, "k"];
    return `${Number((value / divisor).toPrecision(3))}${suffix}`;
  }
  if (magnitude < 1e-3) return value.toExponential(2);
  return String(Number(value.toPrecision(4)));
}

/** Thousands separators in the integer part of a plain number. */
function groupDigits(text: string): string {
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** Two ends of a range, with enough digits that they differ: 1,234,500 to 1,234,900 rather than 1.23M to 1.23M. */
export function formatPair(low: number, high: number): [string, string] {
  let pair: [string, string] = [formatValue(low), formatValue(high)];
  for (let digits = 4; pair[0] === pair[1] && low !== high && digits <= 12; digits++) {
    const precise = (value: number) => {
      const text = String(Number(value.toPrecision(digits)));
      return /e/.test(text) ? value.toPrecision(digits) : groupDigits(text);
    };
    pair = [precise(low), precise(high)];
  }
  return pair;
}

export const stepText = (run: WandbRun) => (run.step != null ? `step ${formatValue(run.step)}` : null);

export function whereText(run: WandbRun): string {
  return [run.project, run.group, run.host].filter(Boolean).join(" · ");
}

export interface Change {
  message: string;
  variant: "info" | "warning" | "success" | "default";
}

/** What changed between two successful fetches, for toasts. */
export function diffRuns(previous: WandbRun[], next: WandbRun[]): Change[] {
  const before = new Map(previous.map((run) => [run.key, run]));
  const changes: Change[] = [];
  const started = next.filter((run) => !before.has(run.key) && isLive(run));
  // A relay or sweep adds runs in bursts; one toast per project says enough.
  if (started.length > 3) {
    const projects = [...new Set(started.map((run) => run.project))];
    changes.push({ message: `W&B: ${started.length} new runs in ${projects.join(", ")}`, variant: "info" });
  } else {
    for (const run of started) changes.push({ message: `W&B: ${run.name} started (${run.project})`, variant: "info" });
  }
  for (const run of next) {
    const old = before.get(run.key);
    if (!old) continue;
    // Scripts that reopen runs flip them between running and finished on every update.
    if (run.updating && (run.state === "finished" || old.state === "finished")) continue;
    if (old.state !== run.state && run.state !== "unknown") {
      changes.push({
        message: `W&B: ${run.name} ${run.state}`,
        variant: ENDED_BADLY.has(run.state) ? "warning" : run.state === "finished" ? "success" : "default",
      });
    } else if (isActive(run)) {
      const newNonFinite = run.nonFinite.filter((key) => !old.nonFinite.includes(key));
      if (newNonFinite.length) changes.push({ message: `W&B: ${run.name} logged NaN/Inf in ${newNonFinite.join(", ")}`, variant: "warning" });
      if (run.stalledSeconds !== null && old.stalledSeconds === null) {
        changes.push({ message: `W&B: ${run.name} has logged no new steps for ${duration(run.stalledSeconds)}`, variant: "warning" });
      }
    }
  }
  return changes;
}
