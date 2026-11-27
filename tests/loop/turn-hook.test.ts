import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentMessageText,
  notificationThreadId,
  notificationTurnId,
  readTurnHookArgv,
  runTurnHook,
  setTurnHookSpawnerForTest,
  turnCompletedStatus,
  turnHookPath,
} from "../../src/loop/turn-hook";

const roots: string[] = [];

const makeRunDir = (): string => {
  const root = mkdtempSync(join(tmpdir(), "loop-turn-hook-"));
  roots.push(root);
  return root;
};

const writeHook = (runDir: string, value: unknown): void => {
  mkdirSync(join(runDir, ".loop-managed"), { recursive: true });
  writeFileSync(turnHookPath(runDir), JSON.stringify(value));
};

afterEach(() => {
  setTurnHookSpawnerForTest(undefined);
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test("turn hook is absent without turn-hook.json", () => {
  const runDir = makeRunDir();
  const calls: string[][] = [];
  setTurnHookSpawnerForTest((argv) => calls.push(argv));
  expect(readTurnHookArgv(runDir)).toBeUndefined();
  runTurnHook(runDir, {
    event: "proxy-stop",
    reason: "signal",
    stoppedAt: "2026-11-27T00:00:00.000Z",
    threadId: "thread-1",
  });
  expect(calls).toEqual([]);
});

test("turn hook accepts only an absolute non-empty string argv", () => {
  const runDir = makeRunDir();
  writeHook(runDir, {
    argv: ["/abs/owner-event", "hook", "--vendor", "codex"],
  });
  expect(readTurnHookArgv(runDir)).toEqual([
    "/abs/owner-event",
    "hook",
    "--vendor",
    "codex",
  ]);
  writeHook(runDir, { argv: ["relative/cmd"] });
  expect(readTurnHookArgv(runDir)).toBeUndefined();
  writeHook(runDir, { argv: [] });
  expect(readTurnHookArgv(runDir)).toBeUndefined();
  writeHook(runDir, { argv: ["/abs", 3] });
  expect(readTurnHookArgv(runDir)).toBeUndefined();
  writeHook(runDir, { command: "/abs" });
  expect(readTurnHookArgv(runDir)).toBeUndefined();
  mkdirSync(join(runDir, ".loop-managed"), { recursive: true });
  writeFileSync(turnHookPath(runDir), "{not json");
  expect(readTurnHookArgv(runDir)).toBeUndefined();
});

test("turn hook passes one JSON line on stdin and swallows spawner errors", () => {
  const runDir = makeRunDir();
  writeHook(runDir, { argv: ["/abs/owner-event", "hook"] });
  const calls: Array<{ argv: string[]; stdin: string }> = [];
  setTurnHookSpawnerForTest((argv, stdin) => calls.push({ argv, stdin }));
  runTurnHook(runDir, {
    completedAt: "2026-11-27T00:00:00.000Z",
    event: "turn-completed",
    lastAgentMessage: "Turn: done — next: review",
    status: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.argv).toEqual(["/abs/owner-event", "hook"]);
  expect(calls[0]?.stdin.endsWith("\n")).toBe(true);
  expect(JSON.parse(calls[0]?.stdin ?? "{}")).toEqual({
    completedAt: "2026-11-27T00:00:00.000Z",
    event: "turn-completed",
    lastAgentMessage: "Turn: done — next: review",
    status: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
  });
  setTurnHookSpawnerForTest(() => {
    throw new Error("boom");
  });
  expect(() =>
    runTurnHook(runDir, {
      event: "proxy-stop",
      reason: "signal",
      stoppedAt: "x",
      threadId: "thread-1",
    })
  ).not.toThrow();
});

test("turn hook default spawner runs the command detached with the payload", async () => {
  const runDir = makeRunDir();
  const out = join(runDir, "hook-out.json");
  writeHook(runDir, { argv: ["/bin/sh", "-c", `cat > '${out}'`] });
  runTurnHook(runDir, {
    event: "proxy-stop",
    reason: "dead-tmux",
    stoppedAt: "2026-11-27T00:00:00.000Z",
    threadId: "thread-1",
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !existsSync(out)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
    event: "proxy-stop",
    reason: "dead-tmux",
    stoppedAt: "2026-11-27T00:00:00.000Z",
    threadId: "thread-1",
  });
});

test("agentMessage text, ids, and status are extracted from notification params", () => {
  expect(
    agentMessageText({
      item: { id: "i1", text: "final answer", type: "agentMessage" },
      threadId: "thread-1",
      turnId: "turn-1",
    })
  ).toBe("final answer");
  expect(
    agentMessageText({
      item: { content: [{ text: "a", type: "text" }], type: "agent_message" },
    })
  ).toBe("a");
  expect(
    agentMessageText({ item: { text: "cmd", type: "commandExecution" } })
  ).toBeUndefined();
  expect(agentMessageText({})).toBeUndefined();
  expect(notificationThreadId({ threadId: "t" })).toBe("t");
  expect(notificationThreadId({ thread: { id: "t2" } })).toBe("t2");
  expect(notificationTurnId({ turn: { id: "u", status: "failed" } })).toBe("u");
  expect(turnCompletedStatus({ turn: { id: "u", status: "failed" } })).toBe(
    "failed"
  );
  expect(turnCompletedStatus({ status: "interrupted", turn: {} })).toBe(
    "interrupted"
  );
  expect(turnCompletedStatus({ turn: {} })).toBeUndefined();
});
