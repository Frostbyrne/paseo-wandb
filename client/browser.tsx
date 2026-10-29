import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Loading, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type FilterClause,
  type FilterOp,
  projectsRpc,
  type RunSort,
  runsQueryRpc,
  type StateFilter,
  type WandbRun,
} from "../shared/wandb";
import { Chip, Field, LineKey, Segmented } from "./controls";
import { MAX_SELECTED, runLabels, type Selection, seriesColor } from "./model";
import { duration, formatValue, stateColor, useNow } from "./state";

export interface BrowserState {
  /** `entity/project`; the most recently active project when empty. */
  project: string;
  search: string;
  state: StateFilter;
  /** Includes clauses still being typed; only complete ones are sent. */
  filters: FilterClause[];
  sort: RunSort;
}

export const DEFAULT_BROWSER: BrowserState = {
  project: "",
  search: "",
  state: "all",
  filters: [],
  sort: { key: "created", desc: true },
};

const OPS: { value: FilterOp; label: string }[] = [
  { value: "eq", label: "=" },
  { value: "ne", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "matches", label: "~" },
];

const BUILT_IN_SORTS = ["created", "heartbeat", "name", "runtime"];

/** `config.<key>` and `summary.<key>` names seen in the loaded runs, for suggestions. */
function knownKeys(runs: WandbRun[]): string[] {
  const keys = new Set<string>(["group", "jobType", "host", "tags", "name"]);
  for (const run of runs) {
    for (const key of Object.keys(run.config ?? {})) keys.add(`config.${key}`);
    for (const key of Object.keys(run.summary ?? {})) keys.add(`summary.${key}`);
  }
  return [...keys];
}

function Suggestions({ theme, text, keys, onPick }: { theme: PluginTheme; text: string; keys: string[]; onPick: (key: string) => void }) {
  const needle = text.trim().toLowerCase();
  if (!needle || keys.includes(text.trim())) return null;
  const matches = keys.filter((key) => key.toLowerCase().includes(needle)).slice(0, 6);
  if (matches.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {matches.map((key) => (
        <Chip key={key} theme={theme} label={key} onPress={() => onPick(key)} accessibilityLabel={`Use ${key}`} />
      ))}
    </View>
  );
}

function FilterRow({
  theme,
  clause,
  keys,
  onChange,
  onRemove,
}: {
  theme: PluginTheme;
  clause: FilterClause;
  keys: string[];
  onChange: (clause: FilterClause) => void;
  onRemove: () => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <Field theme={theme} label="Filter field" placeholder="config.lr or summary.loss" value={clause.field} onChange={(field) => onChange({ ...clause, field })} width={170} />
        <Segmented theme={theme} label="Comparison" value={clause.op} options={OPS} onChange={(op) => onChange({ ...clause, op })} />
        <Field theme={theme} label="Filter value" placeholder="value" value={clause.value} onChange={(value) => onChange({ ...clause, value })} width={90} />
        <Pressable accessibilityRole="button" accessibilityLabel="Remove filter" onPress={onRemove} hitSlop={6}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14 }}>×</Text>
        </Pressable>
      </View>
      <Suggestions theme={theme} text={clause.field} keys={keys} onPick={(field) => onChange({ ...clause, field })} />
    </View>
  );
}

function sortValue(run: WandbRun, key: string): string | null {
  const value = key.startsWith("config.") ? run.config?.[key.slice(7)] : key.startsWith("summary.") ? run.summary?.[key.slice(8)] : undefined;
  if (value === undefined || value === null) return null;
  return typeof value === "number" ? formatValue(value) : String(value);
}

function RunRow({
  theme,
  run,
  label,
  now,
  slot,
  sortKey,
  onPress,
}: {
  theme: PluginTheme;
  run: WandbRun;
  label: string;
  now: number;
  slot: number | null;
  sortKey: string;
  onPress: () => void;
}) {
  const selected = slot !== null;
  const right = BUILT_IN_SORTS.includes(sortKey) ? (run.headline ? formatValue(run.headline.value) : null) : sortValue(run, sortKey);
  const meta = [
    run.group,
    `${duration((now - Date.parse(run.createdAt)) / 1000)} ago`,
    run.runtime != null ? `ran ${duration(run.runtime)}` : null,
  ].filter(Boolean);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={`Compare ${label}`}
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 7,
        paddingHorizontal: 8,
        borderRadius: 6,
        backgroundColor: selected ? theme.colors.surface2 : "transparent",
      }}
    >
      <View
        style={{
          width: 16,
          height: 16,
          borderRadius: 4,
          borderWidth: 1.5,
          borderColor: selected ? seriesColor(theme, slot) : theme.colors.foregroundMuted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected ? <LineKey color={seriesColor(theme, slot)} width={8} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: stateColor(run, theme, now) }} />
          <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
            {label}
          </Text>
        </View>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {[run.state, ...meta].join(" · ")}
        </Text>
      </View>
      {right ? <Text style={{ color: theme.colors.foreground, fontSize: 12, fontVariant: ["tabular-nums"] }}>{right}</Text> : null}
    </Pressable>
  );
}

/** W&B's runs table: pick a project, filter and sort its runs, and tick runs to compare. */
export function RunsBrowser({
  theme,
  state,
  onState,
  selection,
  onToggle,
}: {
  theme: PluginTheme;
  state: BrowserState;
  onState: (state: BrowserState) => void;
  selection: Selection;
  onToggle: (run: WandbRun) => void;
}) {
  const toast = useToast();
  const now = useNow(60_000);
  const fetchProjects = useRpc(projectsRpc);
  const fetchRuns = useRpc(runsQueryRpc);
  const projects = useQuery({ queryKey: ["wandb-projects"], queryFn: () => fetchProjects({}), staleTime: 5 * 60_000, retry: 1 });
  const list = projects.data?.projects ?? [];
  const active = list.find((project) => `${project.entity}/${project.project}` === state.project) ?? list[0] ?? null;
  const filters = state.filters.filter((clause) => clause.field.trim() && clause.value.trim());
  const sort = state.sort;
  // A key sort is sent once a key is picked; until then the list stays sorted by creation.
  const sentSort = BUILT_IN_SORTS.includes(sort.key) || /^(config|summary)\..+/.test(sort.key) ? sort : { ...sort, key: "created" };
  const runs = useInfiniteQuery({
    queryKey: ["wandb-runs", active?.entity, active?.project, state.search, state.state, filters, sentSort],
    queryFn: ({ pageParam }) =>
      fetchRuns({ entity: active!.entity, project: active!.project, search: state.search, state: state.state, filters, sort: sentSort, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.cursor,
    enabled: active !== null,
    retry: false,
  });
  const loaded = useMemo(() => runs.data?.pages.flatMap((page) => page.runs) ?? [], [runs.data]);
  const keys = useMemo(() => knownKeys(loaded), [loaded]);
  const labels = useMemo(() => runLabels(loaded), [loaded]);
  const slots = new Map(selection.map((entry) => [entry.key, entry.slot]));
  const set = (patch: Partial<BrowserState>) => onState({ ...state, ...patch });
  const customSort = !BUILT_IN_SORTS.includes(sort.key);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const link = { color: theme.colors.accent, fontSize: 12, fontWeight: "600" as const };

  const toggle = (run: WandbRun) => {
    if (!slots.has(run.key) && selection.length >= MAX_SELECTED) {
      toast.show(`Compare up to ${MAX_SELECTED} runs at a time; untick one first.`, { variant: "warning" });
      return;
    }
    onToggle(run);
  };

  if (projects.isPending) return <View style={{ height: 120 }}><Loading /></View>;
  if (projects.error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>Could not list projects: {projects.error.message}</Text>;
  if (!active) return <Text style={muted}>No W&B projects for this account.</Text>;

  return (
    <View style={{ gap: 12 }}>
      <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 6 }}>
        {list.map((project) => {
          const id = `${project.entity}/${project.project}`;
          return (
            <Chip
              key={id}
              theme={theme}
              label={list.some((other) => other.entity !== project.entity) ? id : project.project}
              selected={project === active}
              onPress={() => set({ project: id, filters: [], sort: DEFAULT_BROWSER.sort })}
              accessibilityLabel={`Project ${id}`}
            />
          );
        })}
      </ScrollView>
      <Field theme={theme} label="Search runs" placeholder="Search name, ID, group, or job type" value={state.search} onChange={(search) => set({ search })} />
      <Segmented
        theme={theme}
        label="State"
        value={state.state}
        options={[
          { value: "all", label: "All" },
          { value: "running", label: "Running" },
          { value: "finished", label: "Finished" },
          { value: "failed", label: "Failed" },
          { value: "killed", label: "Killed" },
        ]}
        onChange={(value) => set({ state: value })}
      />
      {state.filters.map((clause, index) => (
        <FilterRow
          key={index}
          theme={theme}
          clause={clause}
          keys={keys}
          onChange={(next) => set({ filters: state.filters.map((other, otherIndex) => (otherIndex === index ? next : other)) })}
          onRemove={() => set({ filters: state.filters.filter((_, otherIndex) => otherIndex !== index) })}
        />
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <Pressable accessibilityRole="button" onPress={() => set({ filters: [...state.filters, { field: "", op: "eq", value: "" }] })}>
          <Text style={link}>+ Filter</Text>
        </Pressable>
        <Text style={muted}>Sort</Text>
        <Segmented
          theme={theme}
          label="Sort by"
          value={customSort ? "custom" : sort.key}
          options={[
            { value: "created", label: "Created" },
            { value: "heartbeat", label: "Updated" },
            { value: "name", label: "Name" },
            { value: "runtime", label: "Runtime" },
            { value: "custom", label: "Key" },
          ]}
          onChange={(key) => set({ sort: { key: key === "custom" ? "summary." : key, desc: key === "name" ? false : true } })}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={sort.desc ? "Sort descending" : "Sort ascending"} onPress={() => set({ sort: { ...sort, desc: !sort.desc } })}>
          <Text style={link}>{sort.desc ? "↓ desc" : "↑ asc"}</Text>
        </Pressable>
      </View>
      {customSort ? (
        <View style={{ gap: 6 }}>
          <Field theme={theme} label="Sort key" placeholder="summary.loss or config.lr" value={sort.key} onChange={(key) => set({ sort: { ...sort, key: key.trim() || "created" } })} />
          <Suggestions theme={theme} text={sort.key} keys={keys.filter((key) => key.startsWith("config.") || key.startsWith("summary."))} onPick={(key) => set({ sort: { ...sort, key } })} />
        </View>
      ) : null}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={muted}>
          {runs.isPending ? "Loading runs…" : `${runs.data?.pages[0]?.total ?? loaded.length} runs`}
          {selection.length ? ` · ${selection.length} of ${MAX_SELECTED} picked` : ""}
        </Text>
        {runs.isFetching && !runs.isPending ? <Text style={muted}>Updating…</Text> : null}
      </View>
      {runs.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>{runs.error.message}</Text> : null}
      <View style={{ gap: 2 }}>
        {loaded.map((run) => (
          <RunRow key={run.key} theme={theme} run={run} label={labels.get(run.key) ?? run.name} now={now} slot={slots.get(run.key) ?? null} sortKey={sort.key} onPress={() => toggle(run)} />
        ))}
      </View>
      {runs.hasNextPage ? (
        <Pressable accessibilityRole="button" disabled={runs.isFetchingNextPage} onPress={() => runs.fetchNextPage()}>
          <Text style={link}>{runs.isFetchingNextPage ? "Loading…" : "Load more"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
