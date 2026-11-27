import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Generic, opt-in turn-boundary hook for the Codex tmux proxy. When an external launcher writes
// `<runDir>/.loop-managed/turn-hook.json` = {"argv": ["/abs/cmd", ...]}, the proxy spawns that
// argv DETACHED and never awaited on each `turn/completed` for the run thread (and once when the
// proxy stops), with stdout/stderr ignored and one JSON object on stdin. Without the file nothing
// is spawned. The proxy's frame forwarding, bridge drain, and steering are unchanged.

export const TURN_HOOK_DIR = ".loop-managed";
export const TURN_HOOK_FILE = "turn-hook.json";
const MAX_LAST_MESSAGE_CHARS = 4000;

export interface TurnCompletedHookPayload {
  completedAt: string;
  event: "turn-completed";
  lastAgentMessage: string | null;
  status: string | null;
  threadId: string;
  turnId: string | null;
}

export interface ProxyStopHookPayload {
  event: "proxy-stop";
  reason: string;
  stoppedAt: string;
  threadId: string;
}

export type TurnHookPayload = TurnCompletedHookPayload | ProxyStopHookPayload;

export type TurnHookSpawner = (argv: string[], stdin: string) => void;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

export const turnHookPath = (runDir: string): string =>
  join(runDir, TURN_HOOK_DIR, TURN_HOOK_FILE);

export const readTurnHookArgv = (runDir: string): string[] | undefined => {
  const path = turnHookPath(runDir);
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!(isRecord(parsed) && Array.isArray(parsed.argv))) {
      return undefined;
    }
    const argv = parsed.argv;
    if (
      argv.length === 0 ||
      !argv.every((part) => typeof part === "string" && part.length > 0)
    ) {
      return undefined;
    }
    const command = argv[0] as string;
    return isAbsolute(command) ? (argv as string[]) : undefined;
  } catch {
    return undefined;
  }
};

const defaultSpawner: TurnHookSpawner = (argv, stdin) => {
  const [command, ...args] = argv;
  if (!command) {
    return;
  }
  const child = spawn(command, args, {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(stdin);
  child.unref();
};

let activeSpawner: TurnHookSpawner = defaultSpawner;

export const setTurnHookSpawnerForTest = (
  spawner: TurnHookSpawner | undefined
): void => {
  activeSpawner = spawner ?? defaultSpawner;
};

export const runTurnHook = (runDir: string, payload: TurnHookPayload): void => {
  const argv = readTurnHookArgv(runDir);
  if (!argv) {
    return;
  }
  try {
    activeSpawner(argv, `${JSON.stringify(payload)}\n`);
  } catch {
    // A hook failure never affects the proxy.
  }
};

const collectText = (value: unknown, parts: string[]): void => {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectText(entry, parts);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.text === "string") {
    parts.push(value.text);
    return;
  }
  if (value.content !== undefined) {
    collectText(value.content, parts);
  }
};

// The text of an `item/completed` agentMessage notification, or undefined for any other item.
export const agentMessageText = (params: unknown): string | undefined => {
  if (!(isRecord(params) && isRecord(params.item))) {
    return undefined;
  }
  const itemType = asString(params.item.type);
  if (itemType !== "agentMessage" && itemType !== "agent_message") {
    return undefined;
  }
  const parts: string[] = [];
  collectText(params.item, parts);
  const text = parts.join("\n").trim();
  return text ? text.slice(-MAX_LAST_MESSAGE_CHARS) : undefined;
};

export const notificationThreadId = (params: unknown): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const thread = isRecord(params.thread) ? params.thread : undefined;
  return asString(params.threadId) ?? asString(thread?.id);
};

export const notificationTurnId = (params: unknown): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return asString(params.turnId) ?? asString(turn?.id);
};

export const turnCompletedStatus = (params: unknown): string | undefined => {
  if (!isRecord(params)) {
    return undefined;
  }
  const turn = isRecord(params.turn) ? params.turn : undefined;
  return asString(params.status) ?? asString(turn?.status);
};
