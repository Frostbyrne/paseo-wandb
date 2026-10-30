import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, ExternalLink, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { isActive, type Logger, type WandbRun, type WandbStatus } from "../shared/wandb";
import { Sparkline } from "./chart";
import { HealthBadges, LiveLine, StopButton } from "./live";
import { duration, formatValue, stateColor, stateText, stepText, summarize, useRefreshWandb, whereText } from "./state";

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
  const parts = [`${summary.active} running`];
  if (summary.updating > 0) parts.push(`${summary.updating} updating`);
  parts.push(`${summary.ended} ended in the last 6h`);
  if (summary.stale > 0) parts.push(`${summary.stale} quiet`);
  if (summary.nonFinite > 0) parts.push(`${summary.nonFinite} with NaN/Inf`);
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
      <LiveLine theme={theme} run={run} />
      <HealthBadges theme={theme} run={run} />
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
        <StopButton theme={theme} run={run} />
      </View>
    </View>
  );
}

/** Runs from one project that share a job type (or group), at this size or more, share a card. */
const GROUP_AT = 4;

interface RunGroup {
  key: string;
  label: string;
  runs: WandbRun[];
}

/** Running runs keep their own cards; finished and updating runs from one job collapse into one. */
function groupRuns(runs: WandbRun[]): (WandbRun | RunGroup)[] {
  const sets = new Map<string, WandbRun[]>();
  for (const run of runs) {
    if (isActive(run)) continue;
    const name = run.jobType || run.group;
    if (!name) continue;
    const key = `${run.project}::${name}`;
    sets.set(key, [...(sets.get(key) ?? []), run]);
  }
  const grouped = new Map([...sets].filter(([, members]) => members.length >= GROUP_AT));
  const placed = new Set<string>();
  const items: (WandbRun | RunGroup)[] = [];
  for (const run of runs) {
    const name = run.jobType || run.group;
    const key = `${run.project}::${name}`;
    if (!isActive(run) && name && grouped.has(key)) {
      if (placed.has(key)) continue;
      placed.add(key);
      items.push({ key, label: `${name} · ${run.project}`, runs: grouped.get(key)! });
    } else {
      items.push(run);
    }
  }
  return items;
}

function GroupCard({
  theme,
  group,
  now,
  onOpen,
  onOpenGroup,
}: {
  theme: PluginTheme;
  group: RunGroup;
  now: number;
  onOpen: (run: WandbRun) => void;
  onOpenGroup: (runs: WandbRun[]) => void;
}) {
  const styles = useStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const updating = group.runs.filter((run) => run.updating);
  const failed = group.runs.filter((run) => run.state === "crashed" || run.state === "failed");
  const latest = Math.max(...group.runs.map((run) => Date.parse(run.heartbeatAt ?? run.createdAt)));
  const color = failed.length ? theme.colors.statusDanger : updating.length ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
  const counts = [
    `${group.runs.length} runs`,
    updating.length ? `${updating.length} updating` : null,
    failed.length ? `${failed.length} crashed or failed` : null,
    `last update ${duration((now - latest) / 1000)} ago`,
  ].filter(Boolean);
  const first = group.runs.find((run) => run.link) ?? group.runs[0];
  return (
    <View style={{ gap: 8 }}>
      <View style={styles.card}>
        <View style={{ ...styles.row, flexShrink: 1 }}>
          <View style={{ ...styles.dot, backgroundColor: color }} />
          <Text style={styles.name} numberOfLines={1}>
            {group.label}
          </Text>
        </View>
        <Text style={styles.muted}>{counts.join(" · ")}</Text>
        <OriginText theme={theme} run={first} />
        <View style={{ ...styles.row, gap: 14, paddingTop: 2 }}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Charts for ${group.label}`} onPress={() => onOpenGroup(updating.length ? updating : group.runs)}>
            <Text style={styles.link}>Charts</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? "Hide" : "Show"} the runs of ${group.label}`} onPress={() => setExpanded(!expanded)}>
            <Text style={styles.link}>{expanded ? "Hide runs" : "Show runs"}</Text>
          </Pressable>
        </View>
      </View>
      {expanded ? group.runs.map((run) => <RunCard key={run.key} theme={theme} run={run} now={now} onOpen={onOpen} />) : null}
    </View>
  );
}

/** W&B-logging scripts in this host's Paseo terminals, including ones that have not logged yet. */
export function LoggerList({
  theme,
  loggers,
  now,
  onOpen,
}: {
  theme: PluginTheme;
  loggers: Logger[];
  now: number;
  onOpen: (workspaceId: string | null, keys: string[]) => void;
}) {
  const styles = useStyles(theme);
  if (loggers.length === 0) return null;
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.heading}>Local scripts</Text>
      {loggers.map((logger) => {
        const logged = logger.runCount
          ? `${logger.runCount} ${logger.runCount === 1 ? "run" : "runs"} logged${logger.lastLogAt ? `, last ${duration((now - Date.parse(logger.lastLogAt)) / 1000)} ago` : ""}`
          : "waiting for its first log";
        const where = [logger.workspaceLabel ? `in ${logger.workspaceLabel}` : null, logger.agentName].filter(Boolean).join(" · ");
        return (
          <View key={logger.pid} style={styles.card}>
            <View style={styles.spread}>
              <View style={{ ...styles.row, flexShrink: 1 }}>
                <View style={{ ...styles.dot, backgroundColor: logger.runCount ? theme.colors.statusSuccess : theme.colors.foregroundMuted }} />
                <Text style={{ ...styles.name, fontFamily: "monospace", fontSize: 13 }} numberOfLines={1}>
                  {logger.command}
                  {logger.processCount > 1 ? ` ×${logger.processCount}` : ""}
                </Text>
              </View>
              <Text style={styles.muted}>pid {logger.pid}</Text>
            </View>
            <Text style={styles.muted}>
              started {duration((now - Date.parse(logger.startedAt)) / 1000)} ago · {logged}
            </Text>
            {where ? <Text style={styles.muted} numberOfLines={1}>{where}</Text> : null}
            {logger.workspaceId ? (
              <Pressable accessibilityRole="button" accessibilityLabel={`Open the W&B tab for ${logger.command}`} onPress={() => onOpen(logger.workspaceId, logger.runKeys)}>
                <Text style={styles.link}>{logger.runKeys.length ? "Charts" : "Open tab"}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function RunList({
  theme,
  runs,
  now,
  selectedKey,
  onOpen,
  onOpenGroup,
  openLabel,
  emptyText = "No W&B runs active or ended in the last 6 hours.",
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  now: number;
  selectedKey?: string | null;
  onOpen: (run: WandbRun) => void;
  /** Collapses large sets of finished runs from one job into a card that opens them together. */
  onOpenGroup?: (runs: WandbRun[]) => void;
  openLabel?: string;
  emptyText?: string;
}) {
  const styles = useStyles(theme);
  const items = useMemo(() => (onOpenGroup ? groupRuns(runs) : runs), [runs, onOpenGroup]);
  if (runs.length === 0) return <Text style={styles.empty}>{emptyText}</Text>;
  return (
    <View style={{ gap: 8 }}>
      {items.map((item) =>
        "runs" in item ? (
          <GroupCard key={item.key} theme={theme} group={item} now={now} onOpen={onOpen} onOpenGroup={onOpenGroup!} />
        ) : (
          <RunCard
            key={item.key}
            theme={theme}
            run={item}
            now={now}
            selected={item.key === selectedKey}
            onOpen={onOpen}
            openLabel={openLabel}
          />
        ),
      )}
    </View>
  );
}
