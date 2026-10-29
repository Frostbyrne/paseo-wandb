import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getRunHistory, getWandbStatus } from "./server/wandb";
import { runHistoryRpc, wandbStatusRpc } from "./shared/wandb";

export default function contribute(server: PluginServerContext) {
  server.handle(wandbStatusRpc, getWandbStatus);
  server.handle(runHistoryRpc, getRunHistory);
  return () => {};
}
