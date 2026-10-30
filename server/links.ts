/// <reference types="node" />
import { mkdir, open, readdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import type { RunLink } from "../shared/wandb";

/**
 * Ties W&B runs to the Paseo workspace whose terminal started them.
 *
 * Paseo terminals export PASEO_WORKSPACE_ID and PASEO_TERMINAL_ID, and every process an agent
 * starts inherits them. A local run's processes hold files open in its `run-<time>-<id>` directory,
 * so /proc gives an exact match. Runs started elsewhere, such as over SSH, only show up as their
 * run URL or directory in the Claude Code transcript of the session that started them.
 */

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "paseo-wandb");
const LINKS_FILE = join(STATE_DIR, "links.json");
const LINK_TTL_MS = 30 * 24 * 3600_000;
const RUN_DIR = /\/(?:offline-)?run-\d{8}_\d{6}-([^/\s"'\\]+)/g;
const RUN_URL = /\/([\w.-]+)\/([\w.-]+)\/runs\/([\w-]+)/g;
const RUN_ID_ENV = /WANDB_RUN_ID["'\s:=\\]+([\w-]+)/g;
const TRANSCRIPT_MAX_INITIAL_BYTES = 16 * 1024 * 1024;
const TRANSCRIPT_MAX_LINE_BYTES = 8 * 1024 * 1024;
const TRANSCRIPT_DEPTH = 5;
/** A transcript mention credits a session only this close to the run's start. */
const MENTION_BEFORE_MS = 10 * 60_000;
const MENTION_AFTER_MS = 30 * 60_000;

/** Paseo terminals export the workspace and terminal; Paseo agents export the agent. */
interface PaseoEnv {
  workspaceId: string | null;
  terminalId: string | null;
  agentId: string | null;
}

async function readPaseoEnv(pid: string): Promise<PaseoEnv | null> {
  let environ: string;
  try {
    environ = await readFile(`/proc/${pid}/environ`, "utf8");
  } catch {
    return null;
  }
  let workspaceId: string | null = null;
  let terminalId: string | null = null;
  let agentId: string | null = null;
  for (const entry of environ.split("\0")) {
    if (entry.startsWith("PASEO_WORKSPACE_ID=")) workspaceId = entry.slice(19) || null;
    else if (entry.startsWith("PASEO_TERMINAL_ID=")) terminalId = entry.slice(18) || null;
    else if (entry.startsWith("PASEO_AGENT_ID=")) agentId = entry.slice(15) || null;
  }
  return workspaceId || terminalId || agentId ? { workspaceId, terminalId, agentId } : null;
}

/** A W&B-logging script running in a Paseo terminal, whether or not it has a run open right now. */
export interface LocalLogger {
  pid: number;
  processCount: number;
  /** The script and its first arguments, such as `train.py sweep-a`. */
  command: string;
  env: PaseoEnv;
  /** Epoch ms. */
  startedAt: number;
  /** Runs this process created or resumed since it started, from its wandb directory. */
  runIds: string[];
  /** Epoch ms of its newest run directory, or null before its first log. */
  lastLogAt: number | null;
}

/** Direct use of wandb, or the framework integrations that log to it. */
const USES_WANDB = /^\s*(?:import\s+wandb\b|from\s+wandb\b)|\bWandbLogger\b|\bWandbCallback\b|report_to\s*=\s*\[?\s*["']wandb["']/m;
const RUN_DIR_NAME = /^(?:offline-)?run-\d{8}_\d{6}-(.+)$/;
/** Linux reports process start times in clock ticks; USER_HZ is 100 on every common build. */
const CLOCK_TICKS = 100;

let bootTime: number | null = null;

async function processStart(pid: string): Promise<number | null> {
  try {
    bootTime ??= Number((await readFile("/proc/stat", "utf8")).match(/^btime (\d+)/m)?.[1]) * 1000;
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Field 22 of /proc/<pid>/stat; the slice starts at field 3.
    return bootTime + (Number(fields[19]) / CLOCK_TICKS) * 1000;
  } catch {
    return null;
  }
}

async function readEnviron(pid: string): Promise<Map<string, string>> {
  const environ = await readFile(`/proc/${pid}/environ`, "utf8").catch(() => "");
  return new Map(
    environ
      .split("\0")
      .filter((entry) => entry.includes("="))
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] as const),
  );
}

/**
 * The script a Python process runs, if any, and whether its source uses wandb. Launchers such as
 * torchrun or accelerate pass the script as a later argument; `python -m pkg.module` names a
 * module, whose source is not read, so only a wandb-core child marks it.
 */
async function scriptOf(pid: string, cwd: string): Promise<{ command: string; usesWandb: boolean } | null> {
  const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
  const module = argv.indexOf("-m");
  const index = argv.findIndex((arg, position) => position > 0 && !arg.startsWith("-") && arg.endsWith(".py"));
  const start = index >= 0 ? index : module >= 0 && argv[module + 1] ? module + 1 : -1;
  if (start < 0) return null;
  // Positional words make the label; flags and their values, paths, globs, addresses, and numbers do not.
  const words: string[] = [];
  for (let position = start + 1; position < argv.length; position++) {
    const arg = argv[position];
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && argv[position + 1] && !argv[position + 1].startsWith("-")) position++;
      continue;
    }
    if (!/[/*=]/.test(arg) && !/^[\d.:e+-]+$/i.test(arg)) words.push(arg);
  }
  const name = index >= 0 ? basename(argv[index]) : `-m ${argv[start]}`;
  const command = [name, ...words.slice(0, 2)].join(" ");
  if (index < 0) return { command, usesWandb: false };
  const source = await readFile(argv[index].startsWith("/") ? argv[index] : join(cwd, argv[index]), "utf8").catch(() => "");
  return { command, usesWandb: USES_WANDB.test(source.slice(0, 256 * 1024)) };
}

/** The process that wrote a run directory, from the `MainThread:<pid>` prefix of its wandb debug log. */
async function writerPid(runDir: string): Promise<string | null> {
  const handle = await open(join(runDir, "logs", "debug.log"), "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, bytesRead).match(/MainThread:(\d+)/)?.[1] ?? null;
  } finally {
    await handle.close();
  }
}

/** Run directories in `dir` that process `pid` touched since `since`, newest last. Several scripts can share a directory. */
async function recentRunDirs(dir: string, since: number, pid: string): Promise<{ id: string; at: number }[]> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const found = await Promise.all(
    entries.map(async (name) => {
      const match = name.match(RUN_DIR_NAME);
      if (!match) return null;
      const info = await stat(join(dir, name)).catch(() => null);
      if (!info || info.mtimeMs < since) return null;
      const writer = await writerPid(join(dir, name));
      return writer === null || writer === pid ? { id: match[1], at: info.mtimeMs } : null;
    }),
  );
  return found.filter((entry): entry is { id: string; at: number } => entry !== null).sort((a, b) => a.at - b.at);
}

/**
 * Local W&B activity: the run directories live processes hold open, mapped to their Paseo terminal,
 * and the W&B-logging scripts in Paseo terminals. Empty off Linux.
 */
async function scanProcesses(): Promise<{ runs: Map<string, PaseoEnv>; loggers: LocalLogger[] }> {
  const runs = new Map<string, PaseoEnv>();
  const loggers: LocalLogger[] = [];
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return { runs, loggers };
  }
  const comms = new Map<string, string>();
  const parents = new Map<string, string>();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
      if (!stat) return;
      comms.set(pid, stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")));
      parents.set(pid, stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    }),
  );
  // wandb starts a wandb-core service on its first run and keeps it for the process's lifetime.
  const hasWandbCore = new Set([...comms].filter(([, comm]) => comm.startsWith("wandb-core")).map(([pid]) => parents.get(pid)));
  await Promise.all(
    [...comms].map(async ([pid, comm]) => {
      if (!/^(wandb|python)/i.test(comm)) return;
      try {
        // The training process and wandb-core both hold the run directory open.
        const ids = new Set<string>();
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
          for (const match of target.matchAll(RUN_DIR)) ids.add(match[1]);
        }
        const env = await readPaseoEnv(pid);
        if (!env) return;
        for (const id of ids) runs.set(id, env);
        if (!/^(python|pypy)/i.test(comm)) return;
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => "");
        const script = await scriptOf(pid, cwd);
        if (!script || !(script.usesWandb || hasWandbCore.has(pid))) return;
        const startedAt = (await processStart(pid)) ?? Date.now();
        const environ = await readEnviron(pid);
        const dirs = await recentRunDirs(join(environ.get("WANDB_DIR") || cwd, "wandb"), startedAt - 5_000, pid);
        loggers.push({
          pid: Number(pid),
          processCount: 1,
          command: script.command,
          env,
          startedAt,
          runIds: [...new Set([...dirs.map((dir) => dir.id), ...ids])],
          lastLogAt: dirs.length ? dirs[dirs.length - 1].at : null,
          cwd,
        } as LocalLogger & { cwd: string });
      } catch {
        // The process exited or is not ours.
      }
    }),
  );
  return { runs, loggers: mergeLoggers(loggers as (LocalLogger & { cwd: string })[]) };
}

/** One entry per script: multi-process launches, such as torchrun's one process per GPU, run it many times. */
function mergeLoggers(loggers: (LocalLogger & { cwd: string })[]): LocalLogger[] {
  const merged = new Map<string, LocalLogger>();
  for (const { cwd, ...logger } of loggers.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)) {
    const key = JSON.stringify([logger.command, cwd, logger.env]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, logger);
      continue;
    }
    existing.processCount++;
    existing.runIds = [...new Set([...existing.runIds, ...logger.runIds])];
    existing.lastLogAt = Math.max(existing.lastLogAt ?? 0, logger.lastLogAt ?? 0) || null;
  }
  return [...merged.values()];
}

interface ClaudeSession {
  sessionId: string;
  name: string | null;
  cwd: string | null;
  env: PaseoEnv;
}

/** Live Claude Code sessions running in Paseo terminals, from `~/.claude/sessions/<pid>.json`. */
async function readClaudeSessions(): Promise<ClaudeSession[]> {
  let files: string[];
  try {
    files = (await readdir(join(CLAUDE_DIR, "sessions"))).filter((name) => /^\d+\.json$/.test(name));
  } catch {
    return [];
  }
  const sessions = await Promise.all(
    files.map(async (file): Promise<ClaudeSession | null> => {
      try {
        const record = JSON.parse(await readFile(join(CLAUDE_DIR, "sessions", file), "utf8")) as Record<string, unknown>;
        const pid = String(record.pid ?? basename(file, ".json"));
        const env = await readPaseoEnv(pid);
        if (!env || typeof record.sessionId !== "string") return null;
        return {
          sessionId: record.sessionId,
          name: typeof record.name === "string" ? record.name : null,
          cwd: typeof record.cwd === "string" ? record.cwd : null,
          env,
        };
      } catch {
        return null;
      }
    }),
  );
  return sessions.filter((session): session is ClaudeSession => session !== null);
}

interface Mention {
  sessionId: string;
  /** Epoch ms of the transcript line, or 0 when it has none. */
  at: number;
  entity: string | null;
  project: string | null;
}

interface TranscriptCursor {
  offset: number;
  carry: string;
}

/** Remembers run mentions in Claude Code transcripts, reading each file incrementally. */
class TranscriptIndex {
  private readonly cursors = new Map<string, TranscriptCursor>();
  private readonly mentions = new Map<string, Mention[]>();

  /**
   * The session that mentioned the run first around its start. wandb prints the run URL when the
   * run starts, so the session that started it sees it then; sessions that look a run up later
   * fall outside the window and are not credited.
   */
  find(id: string, entity: string, project: string, createdAt: number): Mention | null {
    const candidates = (this.mentions.get(id) ?? []).filter(
      (mention) =>
        (mention.entity === null || (mention.entity === entity && mention.project === project)) &&
        mention.at >= createdAt - MENTION_BEFORE_MS &&
        mention.at <= createdAt + MENTION_AFTER_MS,
    );
    candidates.sort((a, b) => a.at - b.at);
    return candidates[0] ?? null;
  }

  async update(since: number): Promise<void> {
    const root = join(CLAUDE_DIR, "projects");
    for (const path of await listTranscripts(root, since)) {
      await this.read(path, sessionIdFor(root, path)).catch(() => undefined);
    }
  }

  private async read(path: string, sessionId: string): Promise<void> {
    const { size } = await stat(path);
    let cursor = this.cursors.get(path);
    if (!cursor || size < cursor.offset) {
      cursor = { offset: Math.max(0, size - TRANSCRIPT_MAX_INITIAL_BYTES), carry: "" };
      this.cursors.set(path, cursor);
    }
    if (size === cursor.offset) return;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(size - cursor.offset);
      await handle.read(buffer, 0, buffer.length, cursor.offset);
      cursor.offset = size;
      const lines = (cursor.carry + buffer.toString("utf8")).split("\n");
      const carry = lines.pop() ?? "";
      cursor.carry = carry.length > TRANSCRIPT_MAX_LINE_BYTES ? "" : carry;
      for (const line of lines) this.scanLine(line, sessionId);
    } finally {
      await handle.close();
    }
  }

  private scanLine(line: string, sessionId: string): void {
    if (!/wandb|WANDB|run-\d{8}_/.test(line)) return;
    const stamp = line.match(/"timestamp":"([^"]+)"/);
    const at = stamp ? Date.parse(stamp[1]) || 0 : 0;
    const add = (id: string, entity: string | null, project: string | null) => {
      const list = this.mentions.get(id) ?? [];
      if (!list.some((mention) => mention.sessionId === sessionId && mention.entity === entity)) {
        list.push({ sessionId, at, entity, project });
        this.mentions.set(id, list);
      }
    };
    for (const match of line.matchAll(RUN_URL)) {
      if (line.slice(Math.max(0, (match.index ?? 0) - 64), match.index).includes("wandb")) add(match[3], match[1], match[2]);
    }
    for (const match of line.matchAll(RUN_DIR)) add(match[1], null, null);
    for (const match of line.matchAll(RUN_ID_ENV)) add(match[1], null, null);
  }
}

/** Top-level session transcripts and their subagent transcripts modified since `since`. */
async function listTranscripts(root: string, since: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // A directory's mtime does not change when a transcript inside it grows, so walk them all.
      if (entry.isDirectory()) {
        if (depth < TRANSCRIPT_DEPTH) await walk(path, depth + 1);
      } else if (entry.name.endsWith(".jsonl") && entry.name !== "journal.jsonl") {
        const info = await stat(path).catch(() => null);
        if (info && info.mtimeMs >= since) found.push(path);
      }
    }
  };
  await walk(root, 0);
  return found;
}

/** `<project>/<session>.jsonl` or `<project>/<session>/subagents/…/agent-*.jsonl`. */
function sessionIdFor(root: string, path: string): string {
  const parts = relative(root, path).split(sep);
  return parts.length > 2 ? parts[1] : basename(path, ".jsonl");
}

interface StoredLink {
  link: RunLink;
  linkedAt: number;
}

export interface LinkRequest {
  key: string;
  entity: string;
  project: string;
  id: string;
  /** Epoch ms. */
  createdAt: number;
}

/** Records `link` for `key`; true when that changed what is saved. */
function remember(stored: Map<string, StoredLink>, key: string, link: RunLink): boolean {
  const previous = stored.get(key)?.link;
  if (previous && JSON.stringify(previous) === JSON.stringify(link)) return false;
  stored.set(key, { link, linkedAt: Date.now() });
  return true;
}

export class RunLinker {
  private readonly transcripts = new TranscriptIndex();
  private stored: Map<string, StoredLink> | null = null;
  private lastTranscriptScan = 0;
  private transcriptScan: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();

  /**
   * Links for `runs`, keyed by run key. Live processes win over saved links. Runs nothing else
   * explains start a background transcript search, at most once a minute, whose links appear on
   * a later call.
   */
  async resolve(runs: LinkRequest[]): Promise<{ links: Map<string, RunLink>; loggers: (LocalLogger & { agentName: string | null })[] }> {
    const stored = await this.load();
    const [scan, sessions] = await Promise.all([scanProcesses(), readClaudeSessions()]);
    // A script's runs count as its process's even between logs, when no file is open.
    const processes = new Map(scan.runs);
    for (const logger of scan.loggers) for (const id of logger.runIds) if (!processes.has(id)) processes.set(id, logger.env);
    const byTerminal = new Map(sessions.filter((session) => session.env.terminalId).map((session) => [session.env.terminalId!, session]));
    const result = new Map<string, RunLink>();
    const unexplained: LinkRequest[] = [];
    let changed = false;
    for (const run of runs) {
      const env = processes.get(run.id);
      if (env) {
        const session = env.terminalId ? byTerminal.get(env.terminalId) : undefined;
        const link: RunLink = {
          workspaceId: env.workspaceId,
          terminalId: env.terminalId,
          agentId: env.agentId,
          // Keep a name learned earlier if the session has since closed.
          agentName: session?.name ?? stored.get(run.key)?.link.agentName ?? null,
          source: "process",
        };
        result.set(run.key, link);
        changed = remember(stored, run.key, link) || changed;
        continue;
      }
      const saved = stored.get(run.key);
      if (saved) result.set(run.key, saved.link);
      else unexplained.push(run);
    }
    if (changed) await this.persist(stored);

    if (unexplained.length > 0 && !this.transcriptScan && Date.now() - this.lastTranscriptScan > 60_000) {
      this.lastTranscriptScan = Date.now();
      // The first read of large transcripts takes seconds, so it does not hold up the status.
      this.transcriptScan = this.searchTranscripts(stored, unexplained, sessions)
        .catch((error) => console.error("Transcript search failed", error))
        .finally(() => {
          this.transcriptScan = null;
        });
    }
    const loggers = scan.loggers.map((logger) => ({
      ...logger,
      agentName: (logger.env.terminalId ? byTerminal.get(logger.env.terminalId)?.name : undefined) ?? null,
    }));
    return { links: result, loggers };
  }

  /** Saved links only, for runs that come from queries rather than the status poll. */
  async lookup(keys: string[]): Promise<Map<string, RunLink>> {
    const stored = await this.load();
    const result = new Map<string, RunLink>();
    for (const key of keys) {
      const saved = stored.get(key);
      if (saved) result.set(key, saved.link);
    }
    return result;
  }

  private async searchTranscripts(stored: Map<string, StoredLink>, runs: LinkRequest[], sessions: ClaudeSession[]) {
    await this.transcripts.update(Math.min(...runs.map((run) => run.createdAt)) - 3600_000);
    const bySession = new Map(sessions.map((session) => [session.sessionId, session]));
    let changed = false;
    for (const run of runs) {
      if (stored.has(run.key)) continue;
      const mention = this.transcripts.find(run.id, run.entity, run.project, run.createdAt);
      if (!mention) continue;
      const session = bySession.get(mention.sessionId);
      changed =
        remember(stored, run.key, {
          workspaceId: session?.env.workspaceId ?? null,
          terminalId: session?.env.terminalId ?? null,
          agentId: session?.env.agentId ?? null,
          agentName: session?.name ?? null,
          source: "transcript",
        }) || changed;
    }
    if (changed) await this.persist(stored);
  }

  private async load(): Promise<Map<string, StoredLink>> {
    if (this.stored) return this.stored;
    const stored = new Map<string, StoredLink>();
    try {
      const data = JSON.parse(await readFile(LINKS_FILE, "utf8")) as { links?: Record<string, StoredLink> };
      const cutoff = Date.now() - LINK_TTL_MS;
      for (const [key, value] of Object.entries(data.links ?? {})) {
        // Links saved before agent IDs were recorded lack the field.
        if (value?.link && value.linkedAt > cutoff) stored.set(key, { ...value, link: { ...value.link, agentId: value.link.agentId ?? null } });
      }
    } catch {
      // First run, or an unreadable file that the next save replaces.
    }
    this.stored = stored;
    return stored;
  }

  /** Saves are chained so the status poll and a transcript search never share the temporary file. */
  private persist(stored: Map<string, StoredLink>): Promise<void> {
    this.saving = this.saving.then(async () => {
      try {
        await mkdir(dirname(LINKS_FILE), { recursive: true });
        const temporary = `${LINKS_FILE}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, links: Object.fromEntries(stored) }, null, 1));
        await rename(temporary, LINKS_FILE);
      } catch (error) {
        console.error("Could not save run links", error);
      }
    });
    return this.saving;
  }
}
