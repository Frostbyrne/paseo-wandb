import type { PluginPopoverProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { ExternalLink, Loading, ScrollView, SidebarRow, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import type { WandbRun } from "../shared/wandb";
import { MAX_SELECTED } from "./model";
import { openRunInWorkspace, openRunsInWorkspace, REPORTS_ID, SCREEN_ID } from "./navigation";
import { LoggerList, RunList, StatusSummary } from "./runs";
import { diffRuns, summarize, useNow, useWandbStatus } from "./state";

/** Toasts when runs start, finish, or crash, so agent training does not go unnoticed. */
function useChangeToasts(runs: WandbRun[] | undefined, fetchedAt: string | null | undefined) {
  const toast = useToast();
  const previous = useRef<{ fetchedAt: string; runs: WandbRun[] } | null>(null);
  useEffect(() => {
    if (!runs || !fetchedAt || previous.current?.fetchedAt === fetchedAt) return;
    if (previous.current) {
      for (const change of diffRuns(previous.current.runs, runs)) {
        toast.show(change.message, { variant: change.variant, durationMs: 8000 });
      }
    }
    previous.current = { fetchedAt, runs };
  }, [runs, fetchedAt, toast]);
}

export function WandbPopover({ theme, layout, openScreen, close }: PluginPopoverProps) {
  const { data, isPending } = useWandbStatus();
  const now = useNow(15_000);
  const open = (run: WandbRun) => {
    close();
    if (!openRunInWorkspace(run)) openScreen({ screenId: SCREEN_ID, params: { run: run.key } });
  };
  // Several runs open in their workspace's tab when they share one, else in the runs screen.
  const openKeys = (workspaceId: string | null, keys: string[]) => {
    close();
    const picked = keys.slice(0, MAX_SELECTED);
    if (workspaceId && openRunsInWorkspace(workspaceId, picked)) return;
    if (picked.length) openScreen({ screenId: SCREEN_ID, params: { runs: picked.join(",") } });
  };
  return (
    <View style={{ padding: 12, gap: 12, minWidth: layout.compact ? undefined : 360, backgroundColor: theme.colors.surface0 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>Weights & Biases</Text>
      {isPending || !data ? (
        <View style={{ height: 80 }}>
          <Loading />
        </View>
      ) : (
        <>
          <StatusSummary theme={theme} status={data} now={now} />
          <ScrollView style={{ maxHeight: 460 }}>
            <View style={{ gap: 12 }}>
              <LoggerList theme={theme} loggers={data.loggers} now={now} onOpen={openKeys} />
              <RunList theme={theme} runs={data.runs} now={now} onOpen={open} onOpenGroup={(runs) => openKeys(runs[0]?.link?.workspaceId ?? null, runs.map((run) => run.key))} />
            </View>
          </ScrollView>
        </>
      )}
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open all W&B runs"
          onPress={() => {
            close();
            openScreen({ screenId: SCREEN_ID });
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Details</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open W&B reports"
          onPress={() => {
            close();
            openScreen({ screenId: REPORTS_ID });
          }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>Reports</Text>
        </Pressable>
        <ExternalLink href={data?.appUrl ?? "https://wandb.ai"} accessibilityLabel="Open Weights & Biases">
          <Text style={{ color: theme.colors.accent, fontSize: 12, fontWeight: "600" }}>W&B home</Text>
        </ExternalLink>
      </View>
    </View>
  );
}

export function WandbSidebarItem({ theme, currentScreen, openPopover }: PluginSidebarItemProps) {
  const { data, error } = useWandbStatus();
  const now = useNow(30_000);
  useChangeToasts(data?.error ? undefined : data?.runs, data?.fetchedAt);

  let label = "W&B: …";
  let dot: string | null = null;
  if (data) {
    const summary = summarize(data, now);
    const live = [summary.active ? `${summary.active} running` : null, summary.updating ? `${summary.updating} updating` : null].filter(Boolean);
    if (live.length === 0 && summary.waiting) live.push(`${summary.waiting} waiting`);
    if (live.length) {
      label = `W&B: ${live.join(", ")}`;
      dot = summary.nonFinite > 0 ? theme.colors.statusDanger : summary.stale > 0 ? theme.colors.statusWarning : theme.colors.statusSuccess;
    } else {
      label = "W&B: idle";
      if (summary.ended > 0) dot = theme.colors.foregroundMuted;
    }
    if (summary.failedRecently > 0 || data.error) dot = theme.colors.statusDanger;
  } else if (error) {
    label = "W&B: error";
    dot = theme.colors.statusDanger;
  }

  return (
    <SidebarRow
      icon="Activity"
      label={label}
      active={currentScreen?.screenId === SCREEN_ID}
      onPress={() => openPopover(WandbPopover)}
      trailing={
        dot ? (
          <View style={{ paddingRight: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          </View>
        ) : undefined
      }
    />
  );
}
