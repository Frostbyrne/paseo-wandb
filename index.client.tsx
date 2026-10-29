import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, REPORTS_ID, SCREEN_ID, setClient } from "./client/navigation";
import { ReportsPanel, ReportsScreen, RunsPanel, RunsScreen } from "./client/screen";
import { WandbSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  client.addScreen({ id: SCREEN_ID, title: "W&B runs", Component: RunsScreen });
  client.addSidebarFooterItem({ id: "status", title: "W&B runs", Component: WandbSidebarItem });
  client.addWorkspacePanel({ id: PANEL_ID, title: "W&B", icon: "Activity", Component: RunsPanel });
  client.addScreen({ id: REPORTS_ID, title: "W&B reports", Component: ReportsScreen });
  client.addWorkspacePanel({ id: REPORTS_ID, title: "W&B reports", icon: "FileText", Component: ReportsPanel });
  client.addCommandCenterItem({
    id: "open-workspace-runs",
    title: "Show W&B runs from this workspace",
    icon: "Activity",
    context: "workspace",
    keywords: ["wandb", "weights", "biases", "training", "charts"],
    onSelect({ openPanel }) {
      openPanel(PANEL_ID);
    },
  });
  client.addCommandCenterItem({
    id: "open-all-runs",
    title: "Show all W&B runs",
    icon: "Activity",
    context: "global",
    keywords: ["wandb", "weights", "biases", "training", "charts"],
    onSelect({ openScreen }) {
      openScreen({ screenId: SCREEN_ID });
    },
  });
  client.addCommandCenterItem({
    id: "open-workspace-reports",
    title: "Open W&B reports in this workspace",
    icon: "FileText",
    context: "workspace",
    keywords: ["wandb", "weights", "biases", "report"],
    onSelect({ openPanel }) {
      openPanel(REPORTS_ID);
    },
  });
  client.addCommandCenterItem({
    id: "open-reports",
    title: "Show W&B reports",
    icon: "FileText",
    context: "global",
    keywords: ["wandb", "weights", "biases", "report"],
    onSelect({ openScreen }) {
      openScreen({ screenId: REPORTS_ID });
    },
  });
  return () => setClient(null);
}
