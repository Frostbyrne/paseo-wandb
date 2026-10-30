import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type NativeScrollEvent, type NativeSyntheticEvent, Pressable, ScrollView as NativeScrollView, Text, View } from "react-native";
import { isActive, isLive, type LogLine, runLogsRpc, stopRunRpc, type WandbRun } from "../shared/wandb";
import { Toggle } from "./controls";
import { duration, formatValue } from "./state";

const CONFIRM_MS = 5000;
const LOG_POLL_MS = 15_000;
const LOG_HEIGHT = 420;
/** Lines worth a second look in a training log. */
const ALARMING = /traceback|error|exception|warn|nan\b|inf\b|out of memory|oom\b|killed|segmentation fault/i;

export function ProgressBar({ theme, fraction, width = 90 }: { theme: PluginTheme; fraction: number; width?: number }) {
  return (
    <View style={{ width, height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden" }}>
      <View style={{ width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, height: 4, borderRadius: 2, backgroundColor: theme.colors.accent }} />
    </View>
  );
}

/** "36/60 steps · 1.2/min · 20m left" */
export function progressText(run: WandbRun): string | null {
  if (!run.progress) return null;
  const { done, total, unit } = run.progress;
  const parts = [`${formatValue(done)}/${formatValue(total)} ${unit}s`];
  if (run.rate && isActive(run)) {
    const perMinute = run.rate * 60;
    parts.push(perMinute >= 1 ? `${formatValue(perMinute)}/min` : `${formatValue(perMinute * 60)}/h`);
  }
  if (run.etaSeconds !== null && isActive(run)) parts.push(`${duration(run.etaSeconds)} left`);
  return parts.join(" · ");
}

export function gpuText(run: WandbRun): string | null {
  if (!run.gpu) return null;
  const parts = [run.gpu.count > 1 ? `${run.gpu.count} GPUs` : "GPU"];
  if (run.gpu.util !== null) parts.push(`${Math.round(run.gpu.util)}%`);
  if (run.gpu.memory !== null) parts.push(`mem ${Math.round(run.gpu.memory)}%`);
  return parts.join(" ");
}

function Badge({ theme, text, color }: { theme: PluginTheme; text: string; color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
      <Text style={{ color: theme.colors.foreground, fontSize: 11 }} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

/** Problems a live run shows before W&B marks it crashed: NaN metrics, no new steps, idle GPUs. */
export function HealthBadges({ theme, run }: { theme: PluginTheme; run: WandbRun }) {
  const badges: { text: string; color: string }[] = [];
  if (run.nonFinite.length) {
    const keys = run.nonFinite.slice(0, 2).join(", ");
    badges.push({ text: `NaN/Inf in ${keys}${run.nonFinite.length > 2 ? ` +${run.nonFinite.length - 2}` : ""}`, color: theme.colors.statusDanger });
  }
  if (run.stalledSeconds !== null) badges.push({ text: `no new steps for ${duration(run.stalledSeconds)}`, color: theme.colors.statusWarning });
  if (isActive(run) && run.gpu?.util !== null && run.gpu?.util !== undefined && run.gpu.util < 10) {
    badges.push({ text: "GPU idle", color: theme.colors.statusWarning });
  }
  if (badges.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
      {badges.map((badge) => (
        <Badge key={badge.text} theme={theme} text={badge.text} color={badge.color} />
      ))}
    </View>
  );
}

/** Progress bar, rate, time left, and GPU use on one line. */
export function LiveLine({ theme, run }: { theme: PluginTheme; run: WandbRun }) {
  const progress = progressText(run);
  const gpu = gpuText(run);
  if (!progress && !gpu) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      {run.progress ? <ProgressBar theme={theme} fraction={run.progress.done / run.progress.total} /> : null}
      {progress ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{progress}</Text> : null}
      {gpu ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{gpu}</Text> : null}
    </View>
  );
}

/** Stops a run after a second, confirming press within five seconds. */
export function StopButton({ theme, run }: { theme: PluginTheme; run: WandbRun }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const stop = useRpc(stopRunRpc);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const mutation = useMutation({
    mutationFn: () => stop({ entity: run.entity, project: run.project, id: run.id }),
    onSuccess: ({ error }) => {
      if (error) return toast.error(`Could not stop ${run.name}: ${error}`);
      toast.show(`W&B: stop requested for ${run.name}; it ends on its next heartbeat`);
      void queryClient.invalidateQueries({ queryKey: ["wandb-status"] });
      void queryClient.invalidateQueries({ queryKey: ["wandb-runs-by-key"] });
    },
    onError: (error) => toast.error(`Could not stop ${run.name}: ${error.message}`),
  });
  if (!isActive(run)) return null;
  const link = { fontSize: 12, fontWeight: "600" as const };
  if (mutation.isPending) return <Text style={{ ...link, color: theme.colors.foregroundMuted }}>Stopping…</Text>;
  if (armed) {
    return (
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Confirm stopping ${run.name}`}
          onPress={() => {
            setArmed(false);
            mutation.mutate();
          }}
        >
          <Text style={{ ...link, color: theme.colors.statusDanger }}>Confirm stop</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Cancel" onPress={() => setArmed(false)}>
          <Text style={{ ...link, color: theme.colors.foregroundMuted }}>Cancel</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Stop ${run.name}`} onPress={() => setArmed(true)}>
      <Text style={{ ...link, color: theme.colors.statusWarning }}>Stop</Text>
    </Pressable>
  );
}

/** Lines worth a look, keeping whole tracebacks: the indented frames and the exception line after them. */
function alarmingLines(lines: LogLine[]): LogLine[] {
  const kept: LogLine[] = [];
  let inTraceback = false;
  for (const line of lines) {
    if (/^Traceback \(most recent call last\)/.test(line.text)) {
      inTraceback = true;
      kept.push(line);
    } else if (inTraceback) {
      kept.push(line);
      if (!/^\s/.test(line.text)) inTraceback = false;
    } else if (ALARMING.test(line.text)) {
      kept.push(line);
    }
  }
  return kept;
}

function LogRow({ theme, line }: { theme: PluginTheme; line: LogLine }) {
  const alarming = ALARMING.test(line.text);
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, width: 44, textAlign: "right", fontFamily: "monospace" }}>{line.number}</Text>
      <Text
        selectable
        style={{
          flex: 1,
          fontSize: 11,
          fontFamily: "monospace",
          color: alarming ? theme.colors.statusDanger : line.level === "error" ? theme.colors.foregroundMuted : theme.colors.foreground,
        }}
      >
        {line.text || " "}
      </Text>
    </View>
  );
}

/** The run's console output, following the end while it runs unless scrolled up. */
export function LogsView({ theme, run }: { theme: PluginTheme; run: WandbRun }) {
  const fetchLogs = useRpc(runLogsRpc);
  const logs = useQuery({
    queryKey: ["wandb-logs", run.key],
    queryFn: () => fetchLogs({ entity: run.entity, project: run.project, id: run.id }),
    refetchInterval: isLive(run) ? LOG_POLL_MS : false,
    retry: 1,
  });
  const [follow, setFollow] = useState(true);
  const [onlyAlarming, setOnlyAlarming] = useState(false);
  const scroller = useRef<NativeScrollView>(null);
  const lines = onlyAlarming ? alarmingLines(logs.data?.lines ?? []) : (logs.data?.lines ?? []);
  useEffect(() => {
    if (follow) scroller.current?.scrollToEnd({ animated: false });
  }, [logs.data, follow, onlyAlarming]);
  // Scrolling up stops following; scrolling back to the end resumes it.
  const onScroll = ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const atEnd = nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >= nativeEvent.contentSize.height - 24;
    if (atEnd !== follow) setFollow(atEnd);
  };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 14 }}>
        <Text style={muted}>
          {logs.data ? `${logs.data.total} lines${logs.data.total > logs.data.lines.length ? `, last ${logs.data.lines.length} shown` : ""}` : "Loading…"}
        </Text>
        <Toggle theme={theme} label="Only errors and warnings" value={onlyAlarming} onChange={setOnlyAlarming} />
        {isActive(run) ? <Toggle theme={theme} label="Follow" value={follow} onChange={setFollow} /> : null}
        {logs.isFetching ? <Text style={muted}>Updating…</Text> : null}
      </View>
      {logs.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{logs.error.message}</Text> : null}
      {logs.data && logs.data.total === 0 ? (
        <Text style={muted}>No console output. The run may have console logging turned off (wandb.init(settings=wandb.Settings(console="off"))).</Text>
      ) : (
        <ScrollView
          ref={scroller}
          onScroll={onScroll}
          scrollEventThrottle={100}
          style={{ height: LOG_HEIGHT, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}
          contentContainerStyle={{ padding: 10, gap: 2 }}
        >
          {lines.map((line) => (
            <LogRow key={line.number} theme={theme} line={line} />
          ))}
          {onlyAlarming && lines.length === 0 && logs.data ? <Text style={muted}>No errors or warnings in the last {logs.data.lines.length} lines.</Text> : null}
        </ScrollView>
      )}
    </View>
  );
}
