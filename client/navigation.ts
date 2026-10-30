import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { WandbRun } from "../shared/wandb";

export const SCREEN_ID = "runs";
export const PANEL_ID = "runs";
export const REPORTS_ID = "reports";

let client: PluginClientContext | null = null;

export function setClient(next: PluginClientContext | null) {
  client = next;
}

// Workspace panels take no params, so the runs to show travel through this module.
const requests = new Map<string, string[]>();
const listeners = new Set<(workspaceId: string) => void>();

/** Opens a workspace's W&B tab showing `keys`; false when the workspace cannot be opened here. */
export function openRunsInWorkspace(workspaceId: string, keys: string[]): boolean {
  if (!client) return false;
  requests.set(workspaceId, keys);
  try {
    client.openPanel(PANEL_ID, { workspaceId });
  } catch (error) {
    // The workspace was archived or is not loaded in this app.
    console.warn("[paseo-wandb] Could not open the workspace tab", error);
    requests.delete(workspaceId);
    return false;
  }
  for (const listener of listeners) listener(workspaceId);
  return true;
}

/** Opens the run's charts in a tab of the workspace that started it; false when there is none. */
export function openRunInWorkspace(run: WandbRun): boolean {
  return run.link?.workspaceId ? openRunsInWorkspace(run.link.workspaceId, [run.key]) : false;
}

/** The runs a caller asked a workspace's tab to show, once. */
export function takeRequest(workspaceId: string): string[] | null {
  const keys = requests.get(workspaceId) ?? null;
  requests.delete(workspaceId);
  return keys;
}

export function onRequest(listener: (workspaceId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
