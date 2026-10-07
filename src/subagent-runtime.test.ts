import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  buildSystemPrompt,
  extensionCanonicalName,
  extensionNamesForPath,
  extractMessageText,
  filterDeniedExtensions,
  finalTurnFailure,
  lastAssistantText,
  lastStopReason,
  usageOfMessage,
  wrapSession,
  type AgentMessage,
} from "./subagent-runtime.js";

function message(role: string, content: unknown, extra: Record<string, unknown> = {}): AgentMessage {
  return { role, content, ...extra } as unknown as AgentMessage;
}

test("buildSystemPrompt combines common instructions, body, cwd, and agent tag", () => {
  const prompt = buildSystemPrompt("COMMON", { name: "alpha", body: "BODY" }, "/work/dir");
  assert.match(prompt, /COMMON/);
  assert.match(prompt, /BODY/);
  assert.match(prompt, /\/work\/dir/);
  assert.match(prompt, /<active_agent name="alpha"\/>/);
});

test("extractMessageText handles string, blocks, and non-text", () => {
  assert.equal(extractMessageText(message("user", "hello")), "hello");
  assert.equal(
    extractMessageText(message("assistant", [{ type: "text", text: "a" }, { type: "toolCall", name: "t" }, { type: "text", text: "b" }])),
    "a\nb",
  );
  assert.equal(extractMessageText(message("assistant", [{ type: "thinking", thinking: "h" }])), "");
  assert.equal(extractMessageText({} as AgentMessage), "");
});

test("lastAssistantText scans back only and skips empty", () => {
  const messages = [
    message("user", "q1"),
    message("assistant", [{ type: "text", text: "first" }]),
    message("user", "q2"),
    message("assistant", [{ type: "text", text: "   " }]),
  ];
  assert.equal(lastAssistantText(messages, 0), "first");
  assert.equal(lastAssistantText(messages, 2), "");
  assert.equal(lastAssistantText([], 0), "");
});

test("finalTurnFailure flags provider errors and silent limits, tolerates truncation", () => {
  const providerError = [message("assistant", "partial", { stopReason: "error", errorMessage: "boom" })];
  assert.equal(finalTurnFailure(providerError, 0), "boom");
  const silentLimit = [message("assistant", "  ", { stopReason: "length" })];
  assert.match(finalTurnFailure(silentLimit, 0) ?? "", /output token limit/);
  const truncated = [message("assistant", "useful prefix", { stopReason: "length" })];
  assert.equal(finalTurnFailure(truncated, 0), undefined);
  assert.equal(lastStopReason(truncated, 0), "length");
  assert.equal(finalTurnFailure([message("assistant", "ok", { stopReason: "stop" })], 0), undefined);
  const aborted = [message("assistant", "", { stopReason: "aborted" })];
  assert.match(finalTurnFailure(aborted, 0, false) ?? "", /aborted/);
  assert.equal(finalTurnFailure(aborted, 0, true), undefined);
  assert.equal(finalTurnFailure([message("user", "q")], 0), undefined);
});

test("usageOfMessage accumulates provider usage and cost totals", () => {
  const withUsage = message("assistant", "t", {
    usage: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: { total: 0.5 } },
  });
  assert.deepEqual(usageOfMessage(withUsage), { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, cost: 0.5 });
  assert.equal(usageOfMessage(message("assistant", "t")), undefined);
  assert.equal(usageOfMessage(message("assistant", "t", { usage: {} })), undefined);
});

test("extension canonical names cover files, index shims, and package short names", async () => {
  assert.equal(extensionCanonicalName("/x/rename.ts"), "rename");
  assert.equal(extensionCanonicalName("/x/my-ext/index.ts"), "my-ext");
  const base = await mkdtemp(join(tmpdir(), "swarmd-ext-"));
  try {
    const pkgDir = join(base, "node_modules", "@scope", "swarmd");
    await mkdir(join(pkgDir, "src"), { recursive: true });
    const entry = join(pkgDir, "src", "index.ts");
    await writeFile(entry, "export default function() {}");
    await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@scope/swarmd", pi: { extensions: ["./src/index.ts"] } }));
    assert.deepEqual(extensionNamesForPath(entry), ["src", "swarmd"]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("filterDeniedExtensions matches names case-insensitively and drops builtins", () => {
  const paths = ["/ext/rename.ts", "/ext/MCP.ts", "/ext/fff.ts", "builtin:codemode"];
  const { allowed, denied } = filterDeniedExtensions(paths, ["swarmd", "mcp"]);
  assert.deepEqual(allowed, ["/ext/rename.ts", "/ext/fff.ts"]);
  assert.deepEqual(denied, ["/ext/MCP.ts", "builtin:codemode"]);
});

test("AgentMessage alias matches session messages", () => {
  const check: AgentMessage[] = [] as AgentSession["messages"];
  assert.deepEqual(check, []);
});

test("wrapSession emits session_shutdown before disposing once", async () => {
  const calls: string[] = [];
  const fake = {
    extensionRunner: {
      emit: async (event: { type: string }) => {
        calls.push(`emit:${event.type}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    },
    dispose: () => {
      calls.push("dispose");
    },
  } as unknown as AgentSession;
  const handle = wrapSession(fake, () => []);
  await handle.dispose();
  await handle.dispose();
  assert.deepEqual(calls, ["emit:session_shutdown", "dispose"]);
});
