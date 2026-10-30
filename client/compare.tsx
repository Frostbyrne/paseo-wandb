import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { Scalar, WandbRun } from "../shared/wandb";
import { Field, LineKey } from "./controls";
import type { Dash } from "./model";
import { metricMatcher } from "./series";
import { duration } from "./state";

const KEY_WIDTH = 220;
const CELL_WIDTH = 150;

type Cell = Scalar | undefined;

function formatCell(value: Cell): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "number") return String(Number(value.toPrecision(6)));
  return String(value);
}

interface Row {
  key: string;
  values: Cell[];
  differs: boolean;
}

function buildRows(runs: WandbRun[], keys: string[], read: (run: WandbRun, key: string) => Cell): Row[] {
  return keys.map((key) => {
    const values = runs.map((run) => read(run, key));
    return { key, values, differs: new Set(values.map((value) => JSON.stringify(value ?? null))).size > 1 };
  });
}

const unionKeys = (runs: WandbRun[], pick: (run: WandbRun) => Record<string, Scalar> | undefined) =>
  [...new Set(runs.flatMap((run) => Object.keys(pick(run) ?? {})))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

const pad2 = (value: number) => String(value).padStart(2, "0");

function localTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

const META: { key: string; read: (run: WandbRun) => Cell }[] = [
  { key: "state", read: (run) => run.state },
  { key: "project", read: (run) => run.project },
  { key: "group", read: (run) => run.group },
  { key: "job type", read: (run) => run.jobType },
  { key: "tags", read: (run) => run.tags.join(", ") },
  { key: "host", read: (run) => run.host },
  { key: "created", read: (run) => localTime(run.createdAt) },
  { key: "runtime", read: (run) => (run.runtime != null ? duration(run.runtime) : null) },
  { key: "step", read: (run) => run.step },
];

/** Config and summary values side by side, one column per run. */
export function CompareTable({
  theme,
  runs,
  labels,
  colors,
  dashes,
  diffOnly,
}: {
  theme: PluginTheme;
  runs: WandbRun[];
  labels: Map<string, string>;
  colors: Map<string, string>;
  dashes?: Map<string, Dash>;
  diffOnly: boolean;
}) {
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const matches = metricMatcher(search);
    const keep = (row: Row) => (!diffOnly || row.differs || runs.length < 2) && matches(row.key);
    return [
      {
        title: "Run",
        rows: buildRows(runs, META.map((meta) => meta.key), (run, key) => META.find((meta) => meta.key === key)!.read(run)).filter(keep),
      },
      { title: "Config", rows: buildRows(runs, unionKeys(runs, (run) => run.config), (run, key) => run.config?.[key]).filter(keep) },
      { title: "Summary", rows: buildRows(runs, unionKeys(runs, (run) => run.summary), (run, key) => run.summary?.[key]).filter(keep) },
    ];
  }, [runs, diffOnly, search]);
  const width = KEY_WIDTH + CELL_WIDTH * runs.length;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const cell = { width: CELL_WIDTH, paddingVertical: 5, paddingHorizontal: 8 };
  return (
    <View style={{ gap: 10 }}>
      <Field theme={theme} label="Filter keys" placeholder="Filter keys (regex)" value={search} onChange={setSearch} width={260} />
      <ScrollView horizontal style={{ flexGrow: 0 }}>
        <View style={{ width, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
          <View style={{ flexDirection: "row", backgroundColor: theme.colors.surface2 }}>
            <Text style={{ ...muted, ...cell, width: KEY_WIDTH, fontWeight: "600" }}>Key</Text>
            {runs.map((run) => (
              <View key={run.key} style={{ ...cell, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <LineKey color={colors.get(run.key) ?? theme.colors.foregroundMuted} dash={dashes?.get(run.key)} />
                <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
                  {labels.get(run.key) ?? run.name}
                </Text>
              </View>
            ))}
          </View>
          {groups.map((group) => (
            <View key={group.title}>
              <Text style={{ ...muted, fontWeight: "600", paddingHorizontal: 8, paddingTop: 10, paddingBottom: 4 }}>
                {group.title} {group.rows.length === 0 ? (diffOnly ? "· no differences" : "· none") : ""}
              </Text>
              {group.rows.map((row) => (
                <View key={row.key} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: theme.colors.border }}>
                  <Text selectable numberOfLines={2} style={{ ...muted, ...cell, width: KEY_WIDTH }}>
                    {row.key}
                  </Text>
                  {row.values.map((value, index) => (
                    <Text
                      key={runs[index].key}
                      selectable
                      numberOfLines={3}
                      style={{
                        ...cell,
                        color: theme.colors.foreground,
                        fontSize: 12,
                        fontVariant: ["tabular-nums"],
                        fontWeight: row.differs && runs.length > 1 ? "600" : "400",
                      }}
                    >
                      {formatCell(value)}
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
