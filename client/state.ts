import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { isActive, type RunState, runHistoryRpc, type WandbRun, type WandbStatus, wandbStatusRpc } from "../shared/wandb";

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

export function useRunHistory(run: WandbRun | null) {
  const fetchHistory = useRpc(runHistoryRpc);
  const active = run ? isActive(run) : false;
  return useQuery({
    queryKey: ["wandb-history", run?.key ?? null],
    queryFn: () => fetchHistory({ entity: run!.entity, project: run!.project, id: run!.id }),
    enabled: run !== null,
    refetchInterval: active ? POLL_MS : false,
    staleTime: active ? 0 : Infinity,
    retry: 1,
  });
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

export function stateColor(run: WandbRun, theme: PluginTheme, now: number): string {
  if (isStale(run, now)) return theme.colors.statusWarning;
  if (run.state === "running") return theme.colors.statusSuccess;
  if (run.state === "pending") return theme.colors.statusWarning;
  if (ENDED_BADLY.has(run.state)) return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

export interface Summary {
  active: number;
  ended: number;
  /** Running runs whose heartbeat stopped. */
  stale: number;
  /** Runs that crashed or failed within the alert window. */
  failedRecently: number;
}

export function summarize(status: WandbStatus, now: number): Summary {
  const active = status.runs.filter(isActive);
  return {
    active: active.length,
    ended: status.runs.length - active.length,
    stale: active.filter((run) => isStale(run, now)).length,
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
  if (isStale(run, now)) return `no heartbeat for ${duration((now - Date.parse(run.heartbeatAt!)) / 1000)}`;
  if (run.state === "running") return `running ${duration((now - Date.parse(run.createdAt)) / 1000)}`;
  if (run.state === "pending") return "pending";
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
  for (const run of next) {
    const old = before.get(run.key);
    if (!old) {
      if (isActive(run)) changes.push({ message: `W&B: ${run.name} started (${run.project})`, variant: "info" });
    } else if (old.state !== run.state && run.state !== "unknown") {
      changes.push({
        message: `W&B: ${run.name} ${run.state}`,
        variant: ENDED_BADLY.has(run.state) ? "warning" : run.state === "finished" ? "success" : "default",
      });
    }
  }
  return changes;
}
