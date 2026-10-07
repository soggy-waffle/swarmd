import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SubagentServiceConfig, SubagentThinkingLevel } from "./subagent-contracts.js";
import { createSubagentService } from "./subagent-service.js";
import type { PiSessionFactory, PiSessionHandle, WorkerSessionSpec } from "./subagent-runtime.js";

function ev(event: unknown): AgentSessionEvent {
  return event as unknown as AgentSessionEvent;
}

class FakeSession {
  prompts: string[] = [];
  steers: string[] = [];
  aborts = 0;
  disposed = false;
  setCalls: SubagentThinkingLevel[] = [];
  thinking: SubagentThinkingLevel;
  levels: SubagentThinkingLevel[];
  assistantStopReason = "stop";
  assistantError: string | undefined;
  failPromptWith: Error | undefined;
  manual = false;
  autoReleaseOnAbort = true;
  blockers: Array<() => void> = [];
  messagesArr: Array<Record<string, unknown>> = [];
  contextTokens = 100;
  contextPercent = 10;
  createdThinking: SubagentThinkingLevel;

  constructor(
    public spec: WorkerSessionSpec,
    opts: { levels?: SubagentThinkingLevel[] } = {},
  ) {
    this.thinking = spec.thinking;
    this.createdThinking = spec.thinking;
    this.levels = opts.levels ?? ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    void this.spec;
  }

  emit(event: unknown): void {
    this.spec.onEvent(ev(event));
  }

  releaseBlocks(): void {
    const blockers = this.blockers;
    this.blockers = [];
    for (const release of blockers) release();
  }

  assistantMessage(text: string): void {
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    };
    const msg: Record<string, unknown> = {
      role: "assistant",
      content: [{ type: "text", text }],
      usage,
      stopReason: this.assistantStopReason,
    };
    if (this.assistantError !== undefined) msg["errorMessage"] = this.assistantError;
    this.emit({ type: "message_start", message: { role: "assistant" } });
    this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    this.messagesArr.push(msg);
    this.emit({ type: "message_end", message: msg });
    this.emit({ type: "turn_end" });
  }

  toolStart(id: string, name: string): void {
    this.emit({ type: "tool_execution_start", toolCallId: id, toolName: name, args: {} });
  }

  toolUpdate(id: string, name: string, partial: unknown): void {
    this.emit({ type: "tool_execution_update", toolCallId: id, toolName: name, args: {}, partialResult: partial });
  }

  toolEnd(id: string, name: string, isError = false): void {
    const msg = { role: "toolResult", toolName: name, content: [{ type: "text", text: "done" }] };
    this.messagesArr.push(msg);
    this.emit({ type: "tool_execution_end", toolCallId: id, toolName: name, isError });
    this.emit({ type: "message_end", message: msg });
  }

  getHandle(): PiSessionHandle {
    const self = this;
    return {
      prompt: (text: string) => self.runPrompt(text),
      steer: async (text: string) => {
        self.steers.push(text);
      },
      followUp: async (text: string) => {
        self.steers.push(`follow:${text}`);
      },
      abort: async () => {
        self.aborts += 1;
        if (self.autoReleaseOnAbort) self.releaseBlocks();
      },
      dispose: () => {
        self.disposed = true;
      },
      setThinkingLevel: (level: SubagentThinkingLevel) => {
        self.setCalls.push(level);
        self.thinking = (self.levels as string[]).includes(level) ? level : (self.levels[0] ?? "off");
      },
      thinkingLevel: () => self.thinking,
      availableThinking: () => [...self.levels],
      messageCount: () => self.messagesArr.length,
      messages: () => self.messagesArr as never,
      activeToolNames: () => [],
      skillNames: () => [],
      contextUsage: () => ({ tokens: self.contextTokens, percent: self.contextPercent }),
    };
  }

  async runPrompt(text: string): Promise<void> {
    this.prompts.push(text);
    if (this.failPromptWith) throw this.failPromptWith;
    if (this.manual) await new Promise<void>((resolve) => this.blockers.push(resolve));
    this.assistantMessage(`result:${text}`);
  }
}

interface Fixture {
  service: Awaited<ReturnType<typeof createSubagentService>>;
  sessions: FakeSession[];
  config: SubagentServiceConfig;
  base: string;
  modelRuntime: ModelRuntime;
}

async function makeFixture(options: {
  maxConcurrent?: number;
  levels?: SubagentThinkingLevel[];
  factory?: () => PiSessionFactory;
}): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-svc-"));
  const agentsDir = join(base, "agents");
  const skillsDir = join(base, "skills");
  const piAgentDir = join(base, "pi");
  const transcriptDir = join(base, "transcripts");
  await Promise.all([
    mkdir(agentsDir, { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
    mkdir(piAgentDir, { recursive: true }),
    mkdir(transcriptDir, { recursive: true }),
  ]);
  await writeFile(join(agentsDir, "worker.md"), "---\ndescription: W\nmodel: test-provider/thinker\nthinking: low\n---\n\nBody.\n");
  await writeFile(join(agentsDir, "plain.md"), "---\ndescription: P\nmodel: test-provider/plain\n---\n\nBody.\n");
  await writeFile(join(agentsDir, "flash.md"), "---\ndescription: F\nmodel: test-provider/flashlike\n---\n\nBody.\n");
  const instructions = join(base, "SUBAGENT_INSTRUCTIONS.md");
  await writeFile(instructions, "COMMON\n");
  await writeFile(
    join(piAgentDir, "models.json"),
    JSON.stringify({
      providers: {
        "test-provider": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "test",
          models: [
            { id: "plain", reasoning: false, input: ["text"], contextWindow: 8000, maxTokens: 500 },
            { id: "thinker", reasoning: true, input: ["text"], contextWindow: 8000, maxTokens: 500 },
            {
              id: "flashlike",
              reasoning: true,
              input: ["text"],
              contextWindow: 8000,
              maxTokens: 500,
              thinkingLevelMap: { off: "o", low: "l", high: "h", max: "m", minimal: null, medium: null, xhigh: null },
            },
          ],
        },
      },
    }),
  );
  const config: SubagentServiceConfig = {
    agentsDir,
    skillsDir,
    workerInstructionsFile: instructions,
    piAgentDir,
    excludeExtensions: [],
    port: 8787,
    maxConcurrent: options.maxConcurrent ?? 10,
    transcriptDir,
  };
  const modelRuntime = await ModelRuntime.create({
    authPath: join(piAgentDir, "auth.json"),
    modelsPath: join(piAgentDir, "models.json"),
  });
  const sessions: FakeSession[] = [];
  const factory: PiSessionFactory = options.factory
    ? options.factory()
    : (async (spec: WorkerSessionSpec) => {
        const session = new FakeSession(spec, { levels: options.levels });
        sessions.push(session);
        return session.getHandle();
      });
  const service = await createSubagentService(config, { modelRuntime, sessionFactory: factory });
  return { service, sessions, config, base, modelRuntime };
}

async function dispose(fixture: Fixture): Promise<void> {
  await fixture.service.close().catch(() => {});
  await rm(fixture.base, { recursive: true, force: true });
}

function cwd(base: string): string {
  return base;
}

test("spawn validates each item independently", async () => {
  const fixture = await makeFixture({});
  try {
    const outcomes = await fixture.service.spawnSubagents([
      { agent: "worker", prompt: "ok", cwd: cwd(fixture.base) },
      { agent: "missing", prompt: "x", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "   ", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "x", cwd: join(fixture.base, "nope") },
      { agent: "flash", prompt: "x", cwd: cwd(fixture.base), thinking: "medium" },
    ]);
    assert.equal(outcomes.length, 5);
    assert.equal(outcomes[0].success, true);
    assert.match(outcomes[1].error ?? "", /Unknown agent/);
    assert.match(outcomes[2].error ?? "", /non-empty/);
    assert.match(outcomes[3].error ?? "", /not found/);
    assert.match(outcomes[4].error ?? "", /not supported/);
    const agents = await fixture.service.listAgents();
    assert.deepEqual(
      agents.map((entry) => entry.name).sort(),
      ["flash", "plain", "worker"],
    );
  } finally {
    await dispose(fixture);
  }
});

test("generations share one session and track metrics", async () => {
  const fixture = await makeFixture({});
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "FIRST", cwd: cwd(fixture.base) }]);
    assert.equal(spawned.success, true);
    const id = spawned.worker?.id ?? "";
    const waited = await fixture.service.waitSubagents([id], "all", 5);
    assert.equal(waited.timedOut, false);
    assert.equal(waited.finished.length, 1);
    const first = fixture.service.listSubagents()[0];
    assert.equal(first.state, "idle");
    assert.equal(first.generation, 1);
    assert.equal(first.result, "result:FIRST");
    assert.equal(first.turns, 1);
    assert.deepEqual(first.usage, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 });
    assert.equal(first.contextTokens, 100);
    assert.equal(first.contextPercent, 10);
    await fixture.service.sendSubagent(id, "SECOND");
    await fixture.service.waitSubagents([id], "all", 5);
    const second = fixture.service.listSubagents()[0];
    assert.equal(second.generation, 2);
    assert.equal(second.result, "result:SECOND");
    assert.equal(fixture.sessions.length, 1);
    assert.deepEqual(fixture.sessions[0].prompts, ["FIRST", "SECOND"]);
    assert.equal(fixture.sessions[0].messagesArr.length, 2);
  } finally {
    await dispose(fixture);
  }
});

test("maxConcurrent caps starting and running work", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [a, b] = await fixture.service.spawnSubagents([
      { agent: "worker", prompt: "A", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "B", cwd: cwd(fixture.base) },
    ]);
    assert.equal(a.success, true);
    assert.equal(b.success, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.length, 1);
    assert.equal(fixture.service.listSubagents().find((w) => w.id === b.worker?.id)?.state, "queued");
    sessions[0].releaseBlocks();
    await fixture.service.waitSubagents([a.worker?.id ?? ""], "all", 5);
    sessions[1].manual = false;
    sessions[1].releaseBlocks();
    await fixture.service.waitSubagents([b.worker?.id ?? ""], "all", 5);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[1].prompts, ["B"]);
  } finally {
    await dispose(fixture);
  }
});

test("send to idle with busy slots queues and clears the old result", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [a] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "A", cwd: cwd(fixture.base) }]);
    sessions[0].manual = false;
    sessions[0].releaseBlocks();
    await fixture.service.waitSubagents([a.worker?.id ?? ""], "all", 5);
    const [b] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "B", cwd: cwd(fixture.base) }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fixture.service.sendSubagent(a.worker?.id ?? "", "A2");
    const queued = fixture.service.listSubagents().find((w) => w.id === a.worker?.id);
    assert.equal(queued?.state, "queued");
    assert.equal(queued?.result, undefined);
    const timed = await fixture.service.waitSubagents([a.worker?.id ?? ""], "all", 0.05);
    assert.equal(timed.timedOut, true);
    assert.equal(timed.pending.length, 1);
    assert.equal(timed.finished.length, 0);
    sessions[0].manual = false;
    sessions[1].releaseBlocks();
    const done = await fixture.service.waitSubagents([a.worker?.id ?? ""], "all", 5);
    assert.equal(done.finished[0].result, "result:A2");
    assert.equal(done.finished[0].generation, 2);
  } finally {
    await dispose(fixture);
  }
});

test("send during startup merges steering into the first prompt", async () => {
  const sessions: FakeSession[] = [];
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      await factoryGate;
      const session = new FakeSession(spec);
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "ORIGINAL", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await fixture.service.sendSubagent(id, "EXTRA");
    releaseFactory();
    await fixture.service.waitSubagents([id], "all", 5);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].prompts.length, 1);
    assert.match(sessions[0].prompts[0], /ORIGINAL/);
    assert.match(sessions[0].prompts[0], /EXTRA/);
    assert.equal(fixture.service.listSubagents()[0].generation, 1);
  } finally {
    await dispose(fixture);
  }
});

test("stop during startup prevents generation and disposes the late session", async () => {
  const sessions: FakeSession[] = [];
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      await factoryGate;
      const session = new FakeSession(spec);
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "NEVER", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    const stopping = fixture.service.stopSubagents([id]);
    releaseFactory();
    const stopped = await stopping;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const worker = fixture.service.listSubagents()[0];
    assert.equal(worker.state, "stopped");
    assert.equal(sessions[0].prompts.length, 0);
    assert.equal(sessions[0].disposed, true);
    const [next] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "AFTER", cwd: cwd(fixture.base) }]);
    assert.equal(next.success, true);
    await fixture.service.waitSubagents([next.worker?.id ?? ""], "all", 5);
    assert.equal(sessions.length, 2);
  } finally {
    await dispose(fixture);
  }
});

test("stop cancels running work but preserves output and history", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "WORK", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopping = fixture.service.stopSubagents([id]);
    sessions[0].releaseBlocks();
    const outcomes = await stopping;
    assert.equal(outcomes[0].success, true);
    assert.equal(sessions[0].aborts, 1);
    const worker = fixture.service.listSubagents()[0];
    assert.equal(worker.state, "stopped");
    assert.equal(worker.result, "result:WORK");
    assert.equal(sessions[0].messagesArr.length, 1);
  } finally {
    await dispose(fixture);
  }
});

test("provider errors fail the run and resume continues the conversation", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.assistantStopReason = "error";
      session.assistantError = "provider exploded";
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "FAIL", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await fixture.service.waitSubagents([id], "all", 5);
    const failed = fixture.service.listSubagents()[0];
    assert.equal(failed.state, "failed");
    assert.match(failed.error ?? "", /provider exploded/);
    sessions[0].assistantStopReason = "stop";
    sessions[0].assistantError = undefined;
    await fixture.service.sendSubagent(id, "RETRY");
    await fixture.service.waitSubagents([id], "all", 5);
    const retried = fixture.service.listSubagents()[0];
    assert.equal(retried.state, "idle");
    assert.equal(retried.generation, 2);
    assert.equal(retried.error, undefined);
  } finally {
    await dispose(fixture);
  }
});

test("wait any/all/timeout/abort select specific ids", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [a, b] = await fixture.service.spawnSubagents([
      { agent: "worker", prompt: "A", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "B", cwd: cwd(fixture.base) },
    ]);
    const idA = a.worker?.id ?? "";
    const idB = b.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    let anyDone = false;
    const anyWait = fixture.service.waitSubagents([idA, idB], "any", 5).then((result) => {
      anyDone = true;
      return result;
    });
    sessions[0].manual = false;
    sessions[0].releaseBlocks();
    const anyResult = await anyWait;
    assert.equal(anyDone, true);
    assert.equal(anyResult.finished.length, 1);
    assert.equal(anyResult.pending.length, 1);
    const timed = await fixture.service.waitSubagents([idA, idB], "all", 0.05);
    assert.equal(timed.timedOut, true);
    assert.equal(timed.pending.length, 1);
    const controller = new AbortController();
    const abortWait = fixture.service.waitSubagents([idB], "all", 5, controller.signal);
    controller.abort();
    await assert.rejects(abortWait, /aborted/);
    assert.equal(fixture.service.listSubagents().find((w) => w.id === idB)?.state, "running");
    sessions[1].manual = false;
    sessions[1].releaseBlocks();
    const all = await fixture.service.waitSubagents([idA, idB], "all", 5);
    assert.equal(all.pending.length, 0);
    const immediate = await fixture.service.waitSubagents([idA], "all", 5);
    assert.equal(immediate.finished.length, 1);
  } finally {
    await dispose(fixture);
  }
});

test("wait rejects released ids and release wakes waiters", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "A", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = fixture.service.waitSubagents([id], "all", 30);
    const released = await fixture.service.releaseSubagents([id], true);
    assert.equal(released[0].success, true);
    const settled = await waiting;
    assert.equal(settled.finished[0]?.state, "stopped");
    await assert.rejects(fixture.service.waitSubagents([id], "all", 1), /Unknown subagent/);
  } finally {
    await dispose(fixture);
  }
});

test("release queued workers requires force", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [a, b] = await fixture.service.spawnSubagents([
      { agent: "worker", prompt: "A", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "B", cwd: cwd(fixture.base) },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refused = await fixture.service.releaseSubagents([b.worker?.id ?? ""]);
    assert.equal(refused[0].success, false);
    assert.match(refused[0].error ?? "", /force/);
    const forced = await fixture.service.releaseSubagents([b.worker?.id ?? ""], true);
    assert.equal(forced[0].success, true);
    sessions[0].releaseBlocks();
    await fixture.service.waitSubagents([a.worker?.id ?? ""], "all", 5);
    const idleRelease = await fixture.service.releaseSubagents([a.worker?.id ?? ""]);
    assert.equal(idleRelease[0].success, true);
    assert.equal(fixture.service.listSubagents().length, 0);
  } finally {
    await dispose(fixture);
  }
});

test("close rejects pending waits and blocks new work", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "A", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = fixture.service.waitSubagents([id], "all", 30);
    const rejected = assert.rejects(waiting, /closed/);
    await fixture.service.close();
    await rejected;
    await assert.rejects(fixture.service.spawnSubagents([{ agent: "worker", prompt: "B", cwd: cwd(fixture.base) }]), /closed/);
    assert.equal(sessions[0].disposed, true);
  } finally {
    await dispose(fixture);
  }
});

test("configure validates support and sticks across queued/starting/running", async () => {
  const sessions: FakeSession[] = [];
  let releaseFactory!: () => void;
  const factoryGate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      await factoryGate;
      const session = new FakeSession(spec);
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    await assert.rejects(fixture.service.configureSubagent("nope", "high"), /Unknown subagent/);
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "A", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await assert.rejects(fixture.service.configureSubagent(id, "ultra" as SubagentThinkingLevel), /Unknown thinking/);
    const configured = await fixture.service.configureSubagent(id, "high");
    assert.equal(configured.thinking, "high");
    releaseFactory();
    await fixture.service.waitSubagents([id], "all", 5);
    assert.equal(sessions[0].createdThinking, "low");
    assert.equal(sessions[0].thinking, "high");
    assert.deepEqual(sessions[0].setCalls, ["high"]);
    const running = await fixture.service.configureSubagent(id, "medium");
    assert.equal(running.thinking, "medium");
    assert.ok(sessions[0].setCalls.includes("medium"));
  } finally {
    await dispose(fixture);
  }
});

test("stopped worker without a session restarts through the same id", async () => {
  const sessions: FakeSession[] = [];
  let releaseFactory!: () => void;
  let gate = new Promise<void>((resolve) => {
    releaseFactory = resolve;
  });
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      await gate;
      const session = new FakeSession(spec);
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "FIRST", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await fixture.service.stopSubagents([id]);
    assert.equal(fixture.service.listSubagents()[0].state, "stopped");
    await fixture.service.sendSubagent(id, "RESTART");
    releaseFactory();
    await fixture.service.waitSubagents([id], "all", 5);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].prompts.length, 1);
    assert.match(sessions[0].prompts[0], /FIRST/);
    assert.match(sessions[0].prompts[0], /RESTART/);
    assert.equal(fixture.service.listSubagents()[0].generation, 1);
  } finally {
    await dispose(fixture);
  }
});

test("live transcript records deltas, tools, messages, and context", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "LIVE", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessions[0].toolStart("call-1", "read");
    sessions[0].toolUpdate("call-1", "read", "partial output");
    sessions[0].toolEnd("call-1", "read");
    sessions[0].contextTokens = 250;
    sessions[0].contextPercent = 25;
    sessions[0].releaseBlocks();
    await fixture.service.waitSubagents([id], "all", 5);
    const first = fixture.service.inspectSubagent(id, 0, 3);
    assert.ok(first.events.length <= 3);
    assert.ok(first.nextCursor > 0);
    const rest = fixture.service.inspectSubagent(id, first.nextCursor, 1000);
    assert.ok(rest.events.every((event) => event.cursor > first.nextCursor));
    const types = fixture.service.inspectSubagent(id, 0, 1000).events.map((event) => event.type);
    for (const expected of ["created", "run_start", "tool_start", "tool_update", "tool_end", "text_delta", "message", "run_end"]) {
      assert.ok(types.includes(expected), `transcript includes ${expected}`);
    }
    const worker = fixture.service.listSubagents()[0];
    assert.equal(worker.contextTokens, 250);
    assert.equal(worker.contextPercent, 25);
    assert.equal(worker.toolUses, 1);
  } finally {
    await dispose(fixture);
  }
});

test("concurrent same-name tools tracked by call id with sane activity", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "TOOLS", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
    sessions[0].toolStart("call-1", "read");
    sessions[0].toolStart("call-2", "read");
    assert.equal(fixture.service.listSubagents()[0].activity, "read");
    sessions[0].toolEnd("call-1", "read");
    assert.equal(fixture.service.listSubagents()[0].activity, "read");
    sessions[0].toolEnd("call-2", "read");
    sessions[0].releaseBlocks();
    await fixture.service.waitSubagents([id], "all", 5);
    const worker = fixture.service.listSubagents()[0];
    assert.equal(worker.toolUses, 2);
    assert.equal(worker.activity, undefined);
  } finally {
    await dispose(fixture);
  }
});

test("transcript files are owner-only JSONL with full generation history", async () => {
  const fixture = await makeFixture({});
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "ONE", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await fixture.service.waitSubagents([id], "all", 5);
    await fixture.service.sendSubagent(id, "TWO");
    await fixture.service.waitSubagents([id], "all", 5);
    const worker = fixture.service.listSubagents()[0];
    assert.equal((await stat(worker.transcriptPath)).mode & 0o077, 0);
    let events: Array<{ type: string; data: unknown }> = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const text = await readFile(worker.transcriptPath, "utf8").catch(() => "");
      events = text
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string; data: unknown });
      const serialized = JSON.stringify(events);
      if (events.length >= 6 && serialized.includes("result:ONE") && serialized.includes("result:TWO")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(events.length >= 6);
    assert.ok(events.some((entry) => entry.type === "run_end" && JSON.stringify(entry.data).includes("result:ONE")));
    assert.ok(events.some((entry) => entry.type === "run_end" && JSON.stringify(entry.data).includes("result:TWO")));
  } finally {
    await dispose(fixture);
  }
});

test("thinking defaults choose a supported level and explicit conflicts error", async () => {
  const fixture = await makeFixture({});
  try {
    const [flash] = await fixture.service.spawnSubagents([{ agent: "flash", prompt: "F", cwd: cwd(fixture.base) }]);
    assert.equal(flash.success, true);
    assert.equal(flash.worker?.thinking, "low");
    const [plain] = await fixture.service.spawnSubagents([{ agent: "plain", prompt: "P", cwd: cwd(fixture.base) }]);
    assert.equal(plain.worker?.thinking, "off");
    await fixture.service.close();
  } finally {
    await dispose(fixture);
  }
});

test("stop holds its slot until the run actually stops", async () => {
  const sessions: FakeSession[] = [];
  const fixture = await makeFixture({
    maxConcurrent: 1,
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      session.manual = true;
      sessions.push(session);
      return session.getHandle();
    },
  });
  try {
    const [a, b] = await fixture.service.spawnSubagents([
      { agent: "worker", prompt: "A", cwd: cwd(fixture.base) },
      { agent: "worker", prompt: "B", cwd: cwd(fixture.base) },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.length, 1);
    sessions[0].autoReleaseOnAbort = false;
    const stopping = fixture.service.stopSubagents([a.worker?.id ?? ""]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sessions.length, 1);
    sessions[0].releaseBlocks();
    const outcomes = await stopping;
    assert.equal(outcomes[0].success, true);
    sessions[1].manual = false;
    sessions[1].releaseBlocks();
    await fixture.service.waitSubagents([b.worker?.id ?? ""], "all", 5);
    assert.equal(sessions.length, 2);
    assert.deepEqual(sessions[1].prompts, ["B"]);
  } finally {
    await dispose(fixture);
  }
});

test("unknown ids error and results report state", async () => {
  const fixture = await makeFixture({});
  try {
    assert.throws(() => fixture.service.inspectSubagent("nope"), /Unknown subagent/);
    await assert.rejects(fixture.service.sendSubagent("nope", "hi"), /Unknown subagent/);
    await assert.rejects(fixture.service.configureSubagent("nope", "low"), /Unknown subagent/);
    assert.deepEqual(fixture.service.getSubagentResults(["nope"]), [
      { id: "nope", success: false, error: 'Unknown subagent "nope" (released or never existed)' },
    ]);
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "R", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    assert.match(fixture.service.getSubagentResults([id])[0].error ?? "", /worker is/);
    await fixture.service.waitSubagents([id], "all", 5);
    assert.equal(fixture.service.getSubagentResults([id])[0].success, true);
  } finally {
    await dispose(fixture);
  }
});

test("inspection reports firstAvailableCursor and history truncation after rollover", async () => {
  const fixture = await makeFixture({
    factory: () => async (spec: WorkerSessionSpec) => {
      const session = new FakeSession(spec);
      const originalPrompt = session.runPrompt.bind(session);
      session.runPrompt = async (text: string) => {
        for (let i = 0; i < 600; i++) session.toolUpdate(`call-${i}`, "read", `chunk-${i}`);
        await originalPrompt(text);
      };
      return session.getHandle();
    },
  });
  try {
    const [spawned] = await fixture.service.spawnSubagents([{ agent: "worker", prompt: "ROLL", cwd: cwd(fixture.base) }]);
    const id = spawned.worker?.id ?? "";
    await fixture.service.waitSubagents([id], "all", 5);
    const head = fixture.service.inspectSubagent(id, 0, 50);
    assert.equal(head.historyTruncated, true);
    assert.ok((head.firstAvailableCursor ?? 0) > 1);
    const tail = fixture.service.inspectSubagent(id, (head.firstAvailableCursor ?? 0) - 1, 50);
    assert.equal(tail.historyTruncated, false);
  } finally {
    await dispose(fixture);
  }
});
