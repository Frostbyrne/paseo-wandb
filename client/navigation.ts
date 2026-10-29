import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { WandbRun } from "../shared/wandb";

export const SCREEN_ID = "runs";
export const PANEL_ID = "runs";

let client: PluginClientContext | null = null;

export function setClient(next: PluginClientContext | null) {
  client = next;
}

// Workspace panels take no params, so the run to show travels through this module.
const requests = new Map<string, string>();
const listeners = new Set<(workspaceId: string) => void>();

/** Opens the run's charts in a tab of the workspace that started it; false when there is none. */
export function openRunInWorkspace(run: WandbRun): boolean {
  const workspaceId = run.link?.workspaceId;
  if (!client || !workspaceId) return false;
  requests.set(workspaceId, run.key);
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

/** The run a caller asked a workspace's tab to show, once. */
export function takeRequest(workspaceId: string): string | null {
  const key = requests.get(workspaceId) ?? null;
  requests.delete(workspaceId);
  return key;
}

export function onRequest(listener: (workspaceId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
