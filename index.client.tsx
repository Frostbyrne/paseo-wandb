import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, SCREEN_ID, setClient } from "./client/navigation";
import { RunsPanel, RunsScreen } from "./client/screen";
import { WandbSidebarItem } from "./client/sidebar";

export default function contribute(client: PluginClientContext) {
  setClient(client);
  client.addScreen({ id: SCREEN_ID, title: "W&B runs", Component: RunsScreen });
  client.addSidebarFooterItem({ id: "status", title: "W&B runs", Component: WandbSidebarItem });
  client.addWorkspacePanel({ id: PANEL_ID, title: "W&B", icon: "Activity", Component: RunsPanel });
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
  return () => setClient(null);
}
