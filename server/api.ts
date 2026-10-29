/// <reference types="node" />
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://api.wandb.ai";
const REQUEST_TIMEOUT_MS = 20_000;

export class WandbError extends Error {}

export interface Credentials {
  baseUrl: string;
  apiKey: string;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** `base_url` from the wandb CLI's settings file, which `wandb login --host` writes. */
async function settingsBaseUrl(): Promise<string | null> {
  const configDir = process.env.WANDB_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "wandb");
  const text = await readText(join(configDir, "settings"));
  const match = text?.match(/^\s*base_url\s*=\s*(\S+)\s*$/m);
  return match ? match[1] : null;
}

/** The password for `host` in a netrc file, which is where `wandb login` stores the key. */
function netrcPassword(text: string, host: string): string | null {
  const tokens = text.replace(/#.*$/gm, "").split(/\s+/).filter(Boolean);
  let machine: string | null = null;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "machine") machine = tokens[++index] ?? null;
    else if (token === "default") machine = "";
    else if (token === "password" && (machine === host || machine === "")) return tokens[index + 1] ?? null;
  }
  return null;
}

// Re-read on every fetch so `wandb login` changes apply without a reload.
export async function loadCredentials(): Promise<Credentials | null> {
  const baseUrl = (process.env.WANDB_BASE_URL || (await settingsBaseUrl()) || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const fromEnv = process.env.WANDB_API_KEY?.trim();
  if (fromEnv) return { baseUrl, apiKey: fromEnv };
  const netrc = await readText(process.env.NETRC || join(homedir(), ".netrc"));
  if (!netrc) return null;
  const apiKey = netrcPassword(netrc, new URL(baseUrl).hostname);
  return apiKey ? { baseUrl, apiKey } : null;
}

/** Where people open runs: wandb.ai for the hosted API, the API host itself for W&B Server. */
export function appUrl(baseUrl: string): string {
  return baseUrl === DEFAULT_BASE_URL ? "https://wandb.ai" : baseUrl;
}

export async function graphql<T>(credentials: Credentials, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${credentials.baseUrl}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`api:${credentials.apiKey}`).toString("base64")}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
      // react-native's global AbortSignal type shadows Node's here; the runtime value is Node's.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) as RequestInit["signal"],
    });
  } catch (error) {
    throw new WandbError(`Could not reach W&B: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new WandbError("W&B rejected the API key. Run `wandb login` on the daemon machine.");
  }
  const body = (await response.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (!response.ok || !body?.data) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new WandbError(`W&B request failed (HTTP ${response.status})${message ? `: ${message}` : ""}`);
  }
  return body.data;
}

/**
 * Runs one aliased GraphQL field per item in a single request, `chunkSize` items at a time.
 * `field(index)` returns the selection for one alias and `vars(item, index)` its variables,
 * which must be named with the index suffix.
 */
export async function batched<Item, Result>(
  credentials: Credentials,
  items: Item[],
  chunkSize: number,
  declare: (index: number) => string,
  field: (index: number) => string,
  vars: (item: Item, index: number) => Record<string, unknown>,
  shared: { declarations?: string; variables?: Record<string, unknown> } = {},
): Promise<(Result | null)[]> {
  const results: (Result | null)[] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    const chunk = items.slice(start, start + chunkSize);
    const declarations = [shared.declarations, ...chunk.map((_, index) => declare(index))].filter(Boolean).join(", ");
    const selections = chunk.map((_, index) => `a${index}: ${field(index)}`).join("\n");
    const variables = Object.assign({}, shared.variables, ...chunk.map((item, index) => vars(item, index)));
    const data = await graphql<Record<string, Result | null>>(credentials, `query(${declarations}) {\n${selections}\n}`, variables);
    for (let index = 0; index < chunk.length; index++) results.push(data[`a${index}`] ?? null);
  }
  return results;
}
