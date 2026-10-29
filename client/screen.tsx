import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useTabState } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { isActive, type WandbRun } from "../shared/wandb";
import { onRequest, takeRequest } from "./navigation";
import { RunCharts, RunList, StatusSummary, useStyles } from "./runs";
import { stateColor, useNow, useWandbStatus } from "./state";

const pick = (runs: WandbRun[], key: string | null) => runs.find((run) => run.key === key) ?? runs.find(isActive) ?? runs[0] ?? null;

/** A horizontal row of run names for switching charts on narrow layouts. */
function RunChips({
  theme,
  runs,
  selectedKey,
  now,
  onSelect,
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  selectedKey: string | null;
  now: number;
  onSelect: (run: WandbRun) => void;
}) {
  const styles = useStyles(theme);
  if (runs.length < 2) return null;
  return (
    <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 8 }}>
      {runs.map((run) => {
        const selected = run.key === selectedKey;
        return (
          <Pressable
            key={run.key}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Show charts for ${run.name}`}
            onPress={() => onSelect(run)}
            style={{
              ...styles.row,
              gap: 6,
              paddingVertical: 6,
              paddingHorizontal: 10,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: selected ? theme.colors.accent : theme.colors.border,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <View style={{ ...styles.dot, backgroundColor: stateColor(run, theme, now) }} />
            <Text style={{ ...styles.text, fontSize: 12 }} numberOfLines={1}>
              {run.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Every listed run, with charts for the one picked. */
export function RunsScreen({ theme, layout, params }: PluginScreenProps) {
  const { data, isPending } = useWandbStatus();
  const now = useNow(15_000);
  const [selectedKey, setSelectedKey] = useState<string | null>(params.run ?? null);
  useEffect(() => {
    if (params.run) setSelectedKey(params.run);
  }, [params.run]);
  if (isPending || !data) return <Loading />;
  const selected = pick(data.runs, selectedKey);
  const padding = layout.compact ? 16 : 24;
  const charts = selected ? <RunCharts theme={theme} run={selected} now={now} compact={layout.compact} /> : null;

  if (layout.compact) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding, gap: 16 }}>
        <StatusSummary theme={theme} status={data} now={now} />
        <RunChips theme={theme} runs={data.runs} selectedKey={selected?.key ?? null} now={now} onSelect={(run) => setSelectedKey(run.key)} />
        {charts ?? <RunList theme={theme} runs={data.runs} now={now} onOpen={(run) => setSelectedKey(run.key)} />}
      </ScrollView>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ width: 360, flexGrow: 0, borderRightWidth: 1, borderRightColor: theme.colors.border }} contentContainerStyle={{ padding, gap: 16 }}>
        <StatusSummary theme={theme} status={data} now={now} />
        <RunList
          theme={theme}
          runs={data.runs}
          now={now}
          selectedKey={selected?.key ?? null}
          onOpen={(run) => setSelectedKey(run.key)}
        />
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding, gap: 16 }}>
        {charts}
      </ScrollView>
    </View>
  );
}

const panelStateSchema = z.object({ selected: z.string().nullable() });

/** A workspace tab charting the runs that this workspace's terminals started. */
export function RunsPanel({ theme, layout, workspaceId, tab, revision }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme);
  const { data, isPending } = useWandbStatus();
  const now = useNow(15_000);
  const [state, setState] = useTabState(tab, panelStateSchema, { selected: null });
  const setStateRef = useRef(setState);
  setStateRef.current = setState;
  useEffect(() => {
    const apply = () => {
      const key = takeRequest(workspaceId);
      if (key) setStateRef.current({ selected: key });
    };
    apply();
    return onRequest((requested) => {
      if (requested === workspaceId) apply();
    });
  }, [workspaceId, revision]);

  if (isPending || !data) return <Loading />;
  const runs = data.runs.filter((run) => run.link?.workspaceId === workspaceId);
  const selected = pick(runs, state.selected);
  const elsewhere = data.runs.filter((run) => isActive(run) && run.link?.workspaceId !== workspaceId).length;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}
    >
      <RunChips theme={theme} runs={runs} selectedKey={selected?.key ?? null} now={now} onSelect={(run) => setState({ selected: run.key })} />
      {selected ? (
        <RunCharts theme={theme} run={selected} now={now} compact={layout.compact} />
      ) : (
        <View style={{ gap: 6 }}>
          <Text style={styles.heading}>No W&B runs from this workspace</Text>
          <Text style={styles.muted}>
            Runs started from this workspace's terminals in the last 6 hours appear here, with their charts.
            {elsewhere > 0 ? ` ${elsewhere} active ${elsewhere === 1 ? "run is" : "runs are"} in other workspaces or untraced; open the W&B sidebar row to see ${elsewhere === 1 ? "it" : "them"}.` : ""}
          </Text>
          {data.error ? <Text style={styles.danger}>{data.error}</Text> : null}
        </View>
      )}
    </ScrollView>
  );
}
