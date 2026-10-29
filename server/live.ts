/// <reference types="node" />
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { runKey, type runLogsRpc, type stopRunRpc } from "../shared/wandb";
import { graphql, WandbError } from "./api";
import { forgetStatus, requireCredentials } from "./wandb";

const LOG_LINES = 400;
const LOGS_CACHE_MS = 10_000;
const MAX_LINE = 2_000;

const logsCache = new Map<string, { at: number; logs: RpcOutput<typeof runLogsRpc> }>();

/** Terminal colors and carriage-return redraws, as progress bars write them, are noise in a list. */
function clean(line: string): string {
  const plain = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const shown = plain.slice(plain.lastIndexOf("\r") + 1);
  return shown.length > MAX_LINE ? `${shown.slice(0, MAX_LINE)}…` : shown;
}

export async function getRunLogs({ entity, project, id }: RpcInput<typeof runLogsRpc>): Promise<RpcOutput<typeof runLogsRpc>> {
  const key = runKey(entity, project, id);
  const cached = logsCache.get(key);
  if (cached && Date.now() - cached.at < LOGS_CACHE_MS) return cached.logs;
  const credentials = await requireCredentials();
  const data = await graphql<{
    project: {
      run: {
        logLineCount: number | null;
        logLines: { edges: { node: { number: number | null; level: string | null; timestamp: string | null; line: string | null } }[] } | null;
      } | null;
    } | null;
  }>(
    credentials,
    `query($e: String!, $p: String!, $r: String!) { project(name: $p, entityName: $e) { run(name: $r) { logLineCount logLines(last: ${LOG_LINES}) { edges { node { number level timestamp line } } } } } }`,
    { e: entity, p: project, r: id },
  );
  const run = data.project?.run;
  if (!run) throw new WandbError(`W&B has no run ${key}.`);
  const logs = {
    lines: (run.logLines?.edges ?? []).map(({ node }, index) => ({
      number: node.number ?? index,
      level: node.level ?? "info",
      time: node.timestamp,
      text: clean(node.line ?? ""),
    })),
    total: run.logLineCount ?? 0,
  };
  logsCache.set(key, { at: Date.now(), logs });
  for (const [cachedKey, entry] of logsCache) {
    if (Date.now() - entry.at > 5 * 60_000) logsCache.delete(cachedKey);
  }
  return logs;
}

/**
 * Asks W&B to stop the run, as its Stop button does: the wandb library in the training process
 * sees the request on its next heartbeat and ends the run as killed.
 */
export async function stopRun({ entity, project, id }: RpcInput<typeof stopRunRpc>): Promise<RpcOutput<typeof stopRunRpc>> {
  try {
    const credentials = await requireCredentials();
    const data = await graphql<{ project: { run: { id: string; state: string | null } | null } | null }>(
      credentials,
      "query($e: String!, $p: String!, $r: String!) { project(name: $p, entityName: $e) { run(name: $r) { id state } } }",
      { e: entity, p: project, r: id },
    );
    const run = data.project?.run;
    if (!run) return { error: `W&B has no run ${runKey(entity, project, id)}.` };
    if (run.state !== "running" && run.state !== "pending") return { error: `The run is ${run.state ?? "not running"}.` };
    const result = await graphql<{ stopRun: { success: boolean | null } | null }>(
      credentials,
      "mutation($id: ID!) { stopRun(input: { id: $id }) { success } }",
      { id: run.id },
    );
    if (!result.stopRun?.success) return { error: "W&B did not accept the stop request." };
    forgetStatus();
    return { error: null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
