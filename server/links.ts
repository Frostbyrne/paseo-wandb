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

interface PaseoEnv {
  workspaceId: string | null;
  terminalId: string | null;
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
  for (const entry of environ.split("\0")) {
    if (entry.startsWith("PASEO_WORKSPACE_ID=")) workspaceId = entry.slice(19) || null;
    else if (entry.startsWith("PASEO_TERMINAL_ID=")) terminalId = entry.slice(18) || null;
  }
  return workspaceId || terminalId ? { workspaceId, terminalId } : null;
}

/** Run ID to the Paseo terminal of each live local run process. Empty off Linux. */
async function scanProcesses(): Promise<Map<string, PaseoEnv>> {
  const found = new Map<string, PaseoEnv>();
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return found;
  }
  await Promise.all(
    pids.map(async (pid) => {
      try {
        // The training process and wandb-core both hold the run directory open.
        const comm = (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
        if (!/^(wandb|python)/i.test(comm)) return;
        const ids = new Set<string>();
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
          for (const match of target.matchAll(RUN_DIR)) ids.add(match[1]);
        }
        if (ids.size === 0) return;
        const env = await readPaseoEnv(pid);
        if (!env) return;
        for (const id of ids) found.set(id, env);
      } catch {
        // The process exited or is not ours.
      }
    }),
  );
  return found;
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
  async resolve(runs: LinkRequest[]): Promise<Map<string, RunLink>> {
    const stored = await this.load();
    const [processes, sessions] = await Promise.all([scanProcesses(), readClaudeSessions()]);
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
        if (value?.link && value.linkedAt > cutoff) stored.set(key, value);
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
