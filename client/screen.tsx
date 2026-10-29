import type { PluginTheme } from "@getpaseo/plugin";
import { type PluginScreenProps, type PluginWorkspacePanelProps, useTabState } from "@getpaseo/plugin/client";
import { Loading, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { isActive, parseRunKey, type WandbRun } from "../shared/wandb";
import { type BrowserState, DEFAULT_BROWSER, RunsBrowser } from "./browser";
import { Chip, Segmented } from "./controls";
import { Explorer } from "./explorer";
import {
  type ChartPrefs,
  DEFAULT_PREFS,
  MAX_SELECTED,
  prefsSchema,
  runLabels,
  type Selection,
  selectionOf,
  selectionSchema,
  seriesColor,
  toggleSelection,
  useRemembered,
} from "./model";
import { onRequest, takeRequest } from "./navigation";
import { ReportsList, ReportView } from "./report";
import { OriginText, useStyles } from "./runs";
import { stateColor, stateText, useNow, useRunsByKey, useWandbStatus } from "./state";

/** Rows for `keys`: fetched ones when present, else rows already seen in a list. */
function rowsFor(keys: string[], fetched: WandbRun[] | undefined, seen: Map<string, WandbRun>): WandbRun[] {
  return keys.flatMap((key) => {
    const row = fetched?.find((run) => run.key === key) ?? seen.get(key);
    return row ? [row] : [];
  });
}

/** Every run in W&B: the runs browser beside the charts and compare table for the picked runs. */
export function RunsScreen({ theme, layout, params }: PluginScreenProps) {
  const [browser, setBrowser] = useRemembered<BrowserState>("screen.browser", DEFAULT_BROWSER);
  const [selection, setSelection] = useRemembered<Selection>("screen.selection", []);
  const [prefs, setPrefs] = useRemembered<ChartPrefs>("screen.prefs", DEFAULT_PREFS);
  const [pane, setPane] = useState<"runs" | "compare">(params.run ? "compare" : "runs");
  const seen = useRef(new Map<string, WandbRun>()).current;
  const keys = selection.map((entry) => entry.key);
  const fetched = useRunsByKey(keys, [...seen.values()].some((run) => keys.includes(run.key) && isActive(run)));
  const rows = rowsFor(keys, fetched.data?.runs, seen);

  // Opening the screen for one run shows that run's project and adds the run to the comparison.
  useEffect(() => {
    const parsed = params.run ? parseRunKey(params.run) : null;
    if (!parsed || !params.run) return;
    setBrowser({ ...browser, project: `${parsed.entity}/${parsed.project}` });
    if (!selection.some((entry) => entry.key === params.run)) setSelection(toggleSelection(selection.length >= MAX_SELECTED ? selection.slice(1) : selection, params.run));
    setPane("compare");
  }, [params.run]);

  const toggle = (run: WandbRun) => {
    seen.set(run.key, run);
    setSelection(toggleSelection(selection, run.key));
  };
  const padding = layout.compact ? 16 : 24;
  const browserView = <RunsBrowser theme={theme} state={browser} onState={setBrowser} selection={selection} onToggle={toggle} />;
  const explorer = (
    <Explorer
      theme={theme}
      compact={layout.compact}
      runs={rows}
      selection={selection}
      prefs={prefs}
      onPrefs={setPrefs}
      onRemove={(key) => setSelection(selection.filter((entry) => entry.key !== key))}
    />
  );

  if (layout.compact) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding, gap: 16 }}>
        <Segmented
          theme={theme}
          label="Pane"
          value={pane}
          options={[
            { value: "runs", label: "Runs" },
            { value: "compare", label: `Compare (${selection.length})` },
          ]}
          onChange={setPane}
        />
        {pane === "runs" ? browserView : explorer}
      </ScrollView>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ width: 400, flexGrow: 0, borderRightWidth: 1, borderRightColor: theme.colors.border }} contentContainerStyle={{ padding, gap: 16 }}>
        {browserView}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding, gap: 16 }}>
        {explorer}
      </ScrollView>
    </View>
  );
}

const panelStateSchema = z.object({
  /** Null until the user changes it; until then every run from this workspace is compared. */
  selection: selectionSchema.nullable(),
  /** Runs from elsewhere added with "Compare with…". */
  extras: z.array(z.string()),
  prefs: prefsSchema,
});

function CompareWith({
  theme,
  workspaceId,
  selection,
  onToggle,
}: {
  theme: PluginTheme;
  workspaceId: string;
  selection: Selection;
  onToggle: (run: WandbRun) => void;
}) {
  const [open, setOpen] = useState(false);
  const [browser, setBrowser] = useRemembered<BrowserState>(`panel.browser.${workspaceId}`, DEFAULT_BROWSER);
  return (
    <>
      <Chip theme={theme} label="+ Compare with…" onPress={() => setOpen(true)} accessibilityLabel="Compare with runs from any project" />
      <Modal title="Compare with" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <RunsBrowser theme={theme} state={browser} onState={setBrowser} selection={selection} onToggle={onToggle} />
        </Modal.Content>
      </Modal>
    </>
  );
}

/** A workspace tab charting the runs this workspace's terminals started, and any runs added to compare. */
export function RunsPanel({ theme, layout, workspaceId, tab, revision }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme);
  const toast = useToast();
  const { data, isPending } = useWandbStatus();
  const now = useNow(15_000);
  const [state, setState] = useTabState(tab, panelStateSchema, { selection: null, extras: [], prefs: DEFAULT_PREFS });
  const seen = useRef(new Map<string, WandbRun>()).current;
  // Newest first by creation, so chips keep their places as heartbeats arrive.
  const linked = (data?.runs ?? [])
    .filter((run) => run.link?.workspaceId === workspaceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const run of linked) if (!seen.has(run.key)) seen.set(run.key, run);
  const candidates = [...new Set([...linked.map((run) => run.key), ...state.extras])];
  const selection = state.selection ?? selectionOf(linked.map((run) => run.key));
  const fetched = useRunsByKey(candidates, linked.some(isActive));
  const rows = rowsFor(candidates, fetched.data?.runs, seen);
  const stateRef = useRef(state);
  stateRef.current = state;
  const setRef = useRef(setState);
  setRef.current = setState;

  // "Charts" on a run elsewhere asks this tab to show that run.
  useEffect(() => {
    const apply = () => {
      const key = takeRequest(workspaceId);
      if (!key) return;
      const current = stateRef.current;
      setRef.current({ ...current, selection: [{ key, slot: 0 }], extras: current.extras });
    };
    apply();
    return onRequest((requested) => {
      if (requested === workspaceId) apply();
    });
  }, [workspaceId, revision]);

  const update = (patch: Partial<z.infer<typeof panelStateSchema>>) => setState({ ...state, selection, ...patch });
  const toggle = (key: string, row?: WandbRun) => {
    if (row) seen.set(key, row);
    const picked = selection.some((entry) => entry.key === key);
    if (!picked && selection.length >= MAX_SELECTED) {
      toast.show(`Compare up to ${MAX_SELECTED} runs at a time; untick one first.`, { variant: "warning" });
      return;
    }
    const extras = candidates.includes(key) ? state.extras : [...state.extras, key];
    update({ selection: toggleSelection(selection, key), extras });
  };
  const removeExtra = (key: string) =>
    update({ selection: selection.filter((entry) => entry.key !== key), extras: state.extras.filter((extra) => extra !== key) });

  if (isPending || !data) return <Loading />;
  const slots = new Map(selection.map((entry) => [entry.key, entry.slot]));
  const labels = runLabels(rows);
  const nameOf = (key: string) => labels.get(key) ?? parseRunKey(key)?.id ?? key;
  const focus = rows.find((run) => run.key === selection[0]?.key) ?? null;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 16 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        {candidates.map((key) => {
          const slot = slots.get(key);
          const extra = state.extras.includes(key) && !linked.some((run) => run.key === key);
          const run = rows.find((candidate) => candidate.key === key);
          return (
            <View key={key} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <Chip
                theme={theme}
                label={nameOf(key)}
                selected={slot !== undefined}
                color={slot !== undefined ? seriesColor(theme, slot) : null}
                status={run ? stateColor(run, theme, now) : null}
                onPress={() => toggle(key)}
                accessibilityLabel={`${slot !== undefined ? "Hide" : "Show"} ${nameOf(key)}${run ? `, ${stateText(run, now)}` : ""}`}
              />
              {extra ? (
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${nameOf(key)}`} onPress={() => removeExtra(key)} hitSlop={6}>
                  <Text style={styles.muted}>×</Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
        <CompareWith theme={theme} workspaceId={workspaceId} selection={selection} onToggle={(run) => toggle(run.key, run)} />
      </View>
      {candidates.length === 0 ? (
        <View style={{ gap: 6 }}>
          <Text style={styles.heading}>No W&B runs from this workspace</Text>
          <Text style={styles.muted}>
            Runs started from this workspace's terminals appear here with their charts. Use Compare with… to chart any other runs.
          </Text>
          {data.error ? <Text style={styles.danger}>{data.error}</Text> : null}
        </View>
      ) : (
        <>
          {focus && selection.length === 1 ? <OriginText theme={theme} run={focus} /> : null}
          {fetched.error ? <Text style={styles.danger}>{fetched.error.message}</Text> : null}
          <Explorer
            theme={theme}
            compact={layout.compact}
            runs={rows}
            selection={selection}
            prefs={state.prefs}
            onPrefs={(prefs) => update({ prefs })}
          />
        </>
      )}
    </ScrollView>
  );
}

const reportsTabSchema = z.object({ reportId: z.string().nullable() });

/** Reports beside the open report on wide layouts; one or the other on narrow ones. */
function ReportsLayout({
  theme,
  compact,
  reportId,
  onOpen,
  openBrowser,
}: {
  theme: PluginTheme;
  compact: boolean;
  reportId: string | null;
  onOpen: (id: string | null) => void;
  openBrowser?: (url: string) => void;
}) {
  const padding = compact ? 16 : 24;
  const list = <ReportsList theme={theme} selectedId={reportId} onOpen={(report) => onOpen(report.id)} />;
  const view = reportId ? (
    <ReportView key={reportId} theme={theme} compact={compact} id={reportId} onBack={compact ? () => onOpen(null) : undefined} openBrowser={openBrowser} />
  ) : (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Pick a report to read it here.</Text>
  );
  if (compact) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding, gap: 16 }}>
        {reportId ? view : list}
      </ScrollView>
    );
  }
  return (
    <View style={{ flex: 1, flexDirection: "row", backgroundColor: theme.colors.surface0 }}>
      <ScrollView style={{ width: 320, flexGrow: 0, borderRightWidth: 1, borderRightColor: theme.colors.border }} contentContainerStyle={{ padding, gap: 16 }}>
        {list}
      </ScrollView>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding, gap: 16 }}>
        {view}
      </ScrollView>
    </View>
  );
}

/** A workspace tab for W&B reports; the open report is remembered with the tab. */
export function ReportsPanel({ theme, layout, workspaceId, tab, navigation }: PluginWorkspacePanelProps) {
  const [state, setState] = useTabState(tab, reportsTabSchema, { reportId: null });
  const openBrowser = navigation?.openBrowser;
  return (
    <ReportsLayout
      theme={theme}
      compact={layout.compact}
      reportId={state.reportId}
      onOpen={(reportId) => setState({ reportId })}
      openBrowser={openBrowser ? (url) => openBrowser({ url, workspaceId }) : undefined}
    />
  );
}

export function ReportsScreen({ theme, layout, params }: PluginScreenProps) {
  const [reportId, setReportId] = useRemembered<string | null>("screen.report", params.report ?? null);
  useEffect(() => {
    if (params.report) setReportId(params.report);
  }, [params.report]);
  return <ReportsLayout theme={theme} compact={layout.compact} reportId={reportId} onOpen={setReportId} />;
}
