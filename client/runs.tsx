import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, ExternalLink, Loading, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { Series, WandbRun, WandbStatus } from "../shared/wandb";
import { ChartGrid, Sparkline } from "./chart";
import { duration, formatValue, stateColor, stateText, stepText, summarize, useRefreshWandb, useRunHistory, whereText } from "./state";

export function useStyles(theme: PluginTheme) {
  return useMemo(
    () => ({
      column: { gap: 10 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      spread: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 8 },
      card: {
        gap: 4,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      selected: { borderColor: theme.colors.accent },
      dot: { width: 8, height: 8, borderRadius: 4 },
      name: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flexShrink: 1 },
      value: { color: theme.colors.foreground, fontSize: 13, fontVariant: ["tabular-nums" as const] },
      text: { color: theme.colors.foreground, fontSize: 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const },
      heading: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 8 },
    }),
    [theme],
  );
}

export function StatusSummary({ theme, status, now }: { theme: PluginTheme; status: WandbStatus; now: number }) {
  const styles = useStyles(theme);
  const summary = summarize(status, now);
  const refresh = useRefreshWandb();
  const updated = status.fetchedAt ? duration((now - Date.parse(status.fetchedAt)) / 1000) : null;
  const parts = [`${summary.active} running`, `${summary.ended} ended in the last 6h`];
  if (summary.stale > 0) parts.push(`${summary.stale} without heartbeat`);
  return (
    <View style={styles.column}>
      <View style={styles.spread}>
        <Text style={styles.text}>{parts.join(" · ")}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh W&B runs"
          disabled={refresh.isPending}
          onPress={() => refresh.mutate()}
        >
          <Text style={styles.link}>{refresh.isPending ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        {status.user ? <Text style={styles.muted}>{status.user}</Text> : null}
        {updated ? <Text style={styles.muted}>updated {updated} ago</Text> : null}
      </View>
      {status.error ? <Text style={styles.danger}>{status.error}</Text> : null}
    </View>
  );
}

/** Which workspace and Claude session started the run, when the daemon could tell. */
export function OriginText({ theme, run }: { theme: PluginTheme; run: WandbRun }) {
  const styles = useStyles(theme);
  const agent = run.link?.agentName ? ` · ${run.link.agentName}` : "";
  let text = "Not traced to a Paseo workspace";
  if (run.link?.workspaceId) text = `Started in ${run.workspaceLabel ?? "a workspace this daemon no longer has"}${agent}`;
  else if (run.link?.agentName) text = `Started by ${run.link.agentName}`;
  return (
    <Text style={styles.muted} numberOfLines={1}>
      {text}
    </Text>
  );
}

function useCopyUrl(run: WandbRun) {
  const toast = useToast();
  return () =>
    copyText(run.url).then(
      () => toast.show("Copied the run URL"),
      () => toast.error("Could not copy to the clipboard"),
    );
}

export function RunCard({
  theme,
  run,
  now,
  selected = false,
  onOpen,
  openLabel = "Charts",
}: {
  theme: PluginTheme;
  run: WandbRun;
  now: number;
  selected?: boolean;
  onOpen: (run: WandbRun) => void;
  openLabel?: string;
}) {
  const styles = useStyles(theme);
  const copyUrl = useCopyUrl(run);
  const color = stateColor(run, theme, now);
  const step = stepText(run);
  return (
    <View style={selected ? { ...styles.card, ...styles.selected } : styles.card}>
      <View style={styles.spread}>
        <View style={{ ...styles.row, flexShrink: 1 }}>
          <View style={{ ...styles.dot, backgroundColor: color }} />
          <Text style={styles.name} numberOfLines={1}>
            {run.name}
          </Text>
        </View>
        {run.headline ? <Text style={styles.value}>{formatValue(run.headline.value)}</Text> : null}
      </View>
      <View style={styles.spread}>
        <Text style={{ ...styles.muted, flexShrink: 1 }} numberOfLines={1}>
          {whereText(run)}
        </Text>
        {run.headline ? (
          <Text style={{ ...styles.muted, flexShrink: 0 }} numberOfLines={1}>
            {run.headline.key}
          </Text>
        ) : null}
      </View>
      <View style={styles.spread}>
        <Text style={{ ...styles.muted, color, flexShrink: 1 }} numberOfLines={1}>
          {[stateText(run, now), step].filter(Boolean).join(" · ")}
        </Text>
        {run.headline && run.headline.recent.length > 1 ? (
          <Sparkline values={run.headline.recent} width={72} height={16} color={theme.colors.accent} />
        ) : null}
      </View>
      <OriginText theme={theme} run={run} />
      <View style={{ ...styles.row, gap: 14, paddingTop: 2 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${openLabel} for ${run.name}`} onPress={() => onOpen(run)}>
          <Text style={styles.link}>{openLabel}</Text>
        </Pressable>
        <ExternalLink href={run.url} accessibilityLabel={`Open ${run.name} in W&B`}>
          <Text style={styles.link}>Open in W&B</Text>
        </ExternalLink>
        <Pressable accessibilityRole="button" accessibilityLabel={`Copy the URL of ${run.name}`} onPress={copyUrl}>
          <Text style={styles.link}>Copy URL</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function RunList({
  theme,
  runs,
  now,
  selectedKey,
  onOpen,
  openLabel,
  emptyText = "No W&B runs active or ended in the last 6 hours.",
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  now: number;
  selectedKey?: string | null;
  onOpen: (run: WandbRun) => void;
  openLabel?: string;
  emptyText?: string;
}) {
  const styles = useStyles(theme);
  if (runs.length === 0) return <Text style={styles.empty}>{emptyText}</Text>;
  return (
    <View style={{ gap: 8 }}>
      {runs.map((run) => (
        <RunCard
          key={run.key}
          theme={theme}
          run={run}
          now={now}
          selected={run.key === selectedKey}
          onOpen={onOpen}
          openLabel={openLabel}
        />
      ))}
    </View>
  );
}

/** Groups keys like W&B does: by the part before the first slash, ungrouped keys first. */
function sections(metrics: Series[]): { title: string; series: Series[] }[] {
  const groups = new Map<string, Series[]>();
  for (const series of metrics) {
    const slash = series.key.indexOf("/");
    const title = slash > 0 ? series.key.slice(0, slash) : "";
    groups.set(title, [...(groups.get(title) ?? []), series]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([title, series]) => ({ title: title || "Charts", series }));
}

/** A run's header and all its metric and system charts. */
export function RunCharts({ theme, run, now, compact }: { theme: PluginTheme; run: WandbRun; now: number; compact: boolean }) {
  const styles = useStyles(theme);
  const history = useRunHistory(run);
  const copyUrl = useCopyUrl(run);
  const groups = useMemo(() => sections(history.data?.metrics ?? []), [history.data]);
  const color = stateColor(run, theme, now);
  const facts = [
    stepText(run),
    run.jobType ? `job ${run.jobType}` : null,
    `id ${run.id}`,
  ].filter(Boolean);
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4 }}>
        <View style={styles.row}>
          <View style={{ ...styles.dot, backgroundColor: color }} />
          <Text style={{ ...styles.name, fontSize: compact ? 16 : 18 }} numberOfLines={1}>
            {run.name}
          </Text>
        </View>
        <Text style={{ ...styles.muted, color }}>{stateText(run, now)}</Text>
        <Text style={styles.muted}>{whereText(run)}</Text>
        <Text style={styles.muted}>{facts.join(" · ")}</Text>
        <OriginText theme={theme} run={run} />
        <View style={{ ...styles.row, gap: 14, paddingTop: 4 }}>
          <ExternalLink href={run.url} accessibilityLabel={`Open ${run.name} in W&B`}>
            <Text style={styles.link}>Open in W&B</Text>
          </ExternalLink>
          <Pressable accessibilityRole="button" accessibilityLabel={`Copy the URL of ${run.name}`} onPress={copyUrl}>
            <Text style={styles.link}>Copy URL</Text>
          </Pressable>
          {history.isFetching ? <Text style={styles.muted}>Updating…</Text> : null}
        </View>
      </View>
      {history.isPending ? (
        <View style={{ height: 120 }}>
          <Loading />
        </View>
      ) : history.error ? (
        <Text style={styles.danger}>Could not load charts: {history.error.message}</Text>
      ) : (
        <>
          {groups.length === 0 ? <Text style={styles.empty}>No metrics logged yet.</Text> : null}
          {groups.map((group) => (
            <View key={group.title} style={{ gap: 8 }}>
              <Text style={styles.heading}>{group.title}</Text>
              <ChartGrid theme={theme} series={group.series} compact={compact} />
            </View>
          ))}
          {history.data && history.data.omittedKeys > 0 ? (
            <Text style={styles.muted}>{history.data.omittedKeys} more metrics are not charted here; open the run in W&B for all of them.</Text>
          ) : null}
          {history.data && history.data.system.length > 0 ? (
            <View style={{ gap: 8 }}>
              <Text style={styles.heading}>System</Text>
              <ChartGrid theme={theme} series={history.data.system} compact={compact} />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}
