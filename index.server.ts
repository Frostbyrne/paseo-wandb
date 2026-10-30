import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getRunLogs, stopRun } from "./server/live";
import { getMediaFile, getMediaIndex } from "./server/media";
import { listProjects, queryRuns, runsByKey } from "./server/query";
import { getReport, getReportSeries, listReports } from "./server/reports";
import { getRunHistory, getWandbStatus } from "./server/wandb";
import {
  mediaFileRpc,
  mediaIndexRpc,
  projectsRpc,
  reportRpc,
  reportSeriesRpc,
  reportsRpc,
  runHistoryRpc,
  runLogsRpc,
  runsByKeyRpc,
  runsQueryRpc,
  stopRunRpc,
  wandbStatusRpc,
} from "./shared/wandb";

export default function contribute(server: PluginServerContext) {
  server.handle(wandbStatusRpc, getWandbStatus);
  server.handle(runHistoryRpc, getRunHistory);
  server.handle(projectsRpc, listProjects);
  server.handle(runsQueryRpc, queryRuns);
  server.handle(runsByKeyRpc, runsByKey);
  server.handle(runLogsRpc, getRunLogs);
  server.handle(stopRunRpc, stopRun);
  server.handle(reportsRpc, listReports);
  server.handle(reportRpc, getReport);
  server.handle(reportSeriesRpc, getReportSeries);
  server.handle(mediaIndexRpc, getMediaIndex);
  server.handle(mediaFileRpc, getMediaFile);
  return () => {};
}
