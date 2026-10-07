import { randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  SubagentInspection,
  SubagentOperationOutcome,
  SubagentServiceConfig,
  SubagentSnapshot,
  SubagentSpawnOutcome,
  SubagentSpawnTask,
  SubagentState,
  SubagentThinkingLevel,
  SubagentTranscriptEvent,
  SubagentUsage,
  SubagentWaitResult,
  SubagentWorkerService,
} from "./subagent-contracts.js";
import {
  loadAgentDefinitions,
  SUBAGENT_THINKING_LEVELS,
  supportedThinkingFor,
  clampThinkingFor,
  type ResolvedSubagentAgent,
} from "./subagent-definitions.js";
import {
  buildSystemPrompt,
  extractMessageText,
  createRealSessionFactory,
  finalTurnFailure,
  initWorkerRuntimeEnv,
  lastAssistantText,
  lastStopReason,
  readCommonInstructions,
  usageOfMessage,
  type PiSessionFactory,
  type PiSessionHandle,
  type WorkerRuntimeEnv,
} from "./subagent-runtime.js";

export interface SubagentServiceDeps {
  modelRuntime?: ModelRuntime;
  sessionFactory?: PiSessionFactory;
}

interface QueuedItem {
  workerId: string;
  text: string;
}

interface Waiter {
  ids: Set<string>;
  type: "any" | "all";
  settle: () => void;
  cancel: (error: Error) => void;
}

interface WorkerRecord {
  id: string;
  agent: ResolvedSubagentAgent;
  model: Model<Api>;
  cwd: string;
  description: string;
  thinking: SubagentThinkingLevel;
  pendingSteers: string[];
  state: SubagentState;
  generation: number;
  turns: number;
  toolUses: number;
  activeTools: Map<string, string>;
  activity?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  usage: SubagentUsage;
  contextTokens?: number;
  contextPercent?: number;
  result?: string;
  error?: string;
  transcriptPath?: string;
  events: SubagentTranscriptEvent[];
  cursor: number;
  session?: PiSessionHandle;
  systemPrompt: string;
  startup?: Promise<void>;
  startupEpoch: number;
  runPromise?: Promise<void>;
  stopRequested: boolean;
  runStartIndex: number;
  runBuffer: string;
  genText: string;
  initialText: string;
  file?: FileHandle;
  writeChain: Promise<void>;
  disposed: boolean;
}

const MAX_MEMORY_EVENTS = 500;
const MAX_MEMORY_STRING = 4000;

function truncateForMemory(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_MEMORY_STRING ? `${value.slice(0, MAX_MEMORY_STRING)}…[truncated]` : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth > 3) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => truncateForMemory(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = truncateForMemory(entry, depth + 1);
  }
  return out;
}

function summarizePartial(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 2000);
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return "[unserializable]";
  }
}

function isTerminalState(state: SubagentState): boolean {
  return state === "idle" || state === "stopped" || state === "failed";
}

function abortError(): Error {
  return Object.assign(new Error("wait aborted"), { name: "AbortError" });
}

function pickDefaultThinking(levels: SubagentThinkingLevel[]): SubagentThinkingLevel {
  for (const level of ["medium", "low", "high", "minimal", "xhigh", "max", "off"] as const) {
    if (levels.includes(level)) return level;
  }
  return levels[0] ?? "off";
}

export async function createSubagentService(
  config: SubagentServiceConfig,
  deps?: SubagentServiceDeps,
): Promise<SubagentWorkerService> {
  const env: WorkerRuntimeEnv = await initWorkerRuntimeEnv(config, deps?.modelRuntime);
  const sessionFactory: PiSessionFactory = deps?.sessionFactory ?? createRealSessionFactory(env);
  const commonInstructions = await readCommonInstructions(config);

  const workers = new Map<string, WorkerRecord>();
  const queue: QueuedItem[] = [];
  const waiters = new Set<Waiter>();
  const listeners = new Set<() => void>();
  let counter = 0;
  let closed = false;
  const commonPrompt = commonInstructions;

  function assertOpen(): void {
    if (closed) throw new Error("Subagent service is closed");
  }

  function activeCount(): number {
    let count = 0;
    for (const worker of workers.values()) {
      if (worker.state === "starting" || worker.state === "running") count += 1;
    }
    return count;
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error(`subagent subscribe listener failed: ${(error as Error).message}`);
      }
    }
    for (const waiter of [...waiters]) {
      try {
        waiter.settle();
      } catch (error) {
        console.error(`subagent waiter failed: ${(error as Error).message}`);
      }
    }
  }

  function recordEvent(worker: WorkerRecord, type: string, data: unknown): void {
    worker.cursor += 1;
    const timestamp = new Date().toISOString();
    const entry: SubagentTranscriptEvent = {
      cursor: worker.cursor,
      timestamp,
      type,
      data: truncateForMemory(data) as SubagentTranscriptEvent["data"],
    };
    worker.events.push(entry);
    if (worker.events.length > MAX_MEMORY_EVENTS) {
      worker.events.splice(0, worker.events.length - MAX_MEMORY_EVENTS);
    }
    const file = worker.file;
    if (file) {
      const disk = JSON.stringify({ cursor: entry.cursor, timestamp, type, data });
      worker.writeChain = worker.writeChain.then(async () => {
        try {
          await file.appendFile(`${disk}\n`);
        } catch (error) {
          console.error(`subagent transcript append failed for ${worker.id}: ${(error as Error).message}`);
        }
      });
    }
    notify();
  }

  function snapshot(worker: WorkerRecord): SubagentSnapshot {
    return {
      id: worker.id,
      agent: worker.agent.name,
      description: worker.description,
      model: worker.agent.model,
      thinking: worker.thinking,
      cwd: worker.cwd,
      state: worker.state,
      generation: worker.generation,
      turns: worker.turns,
      toolUses: worker.toolUses,
      ...(worker.activity ? { activity: worker.activity } : {}),
      createdAt: worker.createdAt,
      ...(worker.startedAt ? { startedAt: worker.startedAt } : {}),
      ...(worker.completedAt ? { completedAt: worker.completedAt } : {}),
      usage: { ...worker.usage },
      ...(worker.contextTokens !== undefined ? { contextTokens: worker.contextTokens } : {}),
      ...(worker.contextPercent !== undefined ? { contextPercent: worker.contextPercent } : {}),
      ...(worker.result !== undefined ? { result: worker.result } : {}),
      ...(worker.error !== undefined ? { error: worker.error } : {}),
      initialPrompt: worker.initialText,
      ...(worker.transcriptPath ? { transcriptPath: worker.transcriptPath } : {}),
    };
  }

  function requireWorker(id: string): WorkerRecord {
    const worker = workers.get(id);
    if (!worker || worker.disposed) throw new Error(`Unknown subagent "${id}" (released or never existed)`);
    return worker;
  }

  function refreshContext(worker: WorkerRecord): void {
    const context = worker.session?.contextUsage();
    if (context?.tokens !== undefined) worker.contextTokens = context.tokens;
    if (context?.percent !== undefined) worker.contextPercent = context.percent;
  }

  function refreshActivity(worker: WorkerRecord): void {
    const tools = [...new Set(worker.activeTools.values())].sort();
    worker.activity =
      tools.length === 0
        ? undefined
        : tools.length <= 3
          ? tools.join(", ")
          : `${tools.slice(0, 3).join(", ")} (+${tools.length - 3} more)`;
  }

  function handleSessionEvent(worker: WorkerRecord, event: AgentSessionEvent): void {
    switch (event.type) {
      case "tool_execution_start": {
        if (event.parentToolCallId) break;
        worker.activeTools.set(event.toolCallId, event.toolName);
        refreshActivity(worker);
        recordEvent(worker, "tool_start", { tool: event.toolName, id: event.toolCallId });
        break;
      }
      case "tool_execution_update": {
        if (event.parentToolCallId) break;
        recordEvent(worker, "tool_update", {
          tool: event.toolName,
          id: event.toolCallId,
          partial: summarizePartial(event.partialResult),
        });
        break;
      }
      case "tool_execution_end": {
        if (event.parentToolCallId) break;
        worker.activeTools.delete(event.toolCallId);
        worker.toolUses += 1;
        refreshActivity(worker);
        recordEvent(worker, "tool_end", { tool: event.toolName, id: event.toolCallId, error: event.isError === true });
        break;
      }
      case "turn_end": {
        worker.turns += 1;
        refreshContext(worker);
        break;
      }
      case "message_start": {
        if ((event.message as { role?: string }).role === "assistant") worker.runBuffer = "";
        break;
      }
      case "message_update": {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          worker.runBuffer += delta.delta;
          worker.genText += delta.delta;
          recordEvent(worker, "text_delta", { delta: delta.delta });
        } else if (delta.type === "thinking_delta") {
          recordEvent(worker, "thinking_delta", { delta: delta.delta });
        }
        break;
      }
      case "message_end": {
        const message = event.message as { role?: string };
        if (message.role === "assistant" || message.role === "toolResult") {
          const delta = usageOfMessage(event.message);
          if (delta) {
            worker.usage.input += delta.input;
            worker.usage.output += delta.output;
            worker.usage.cacheRead += delta.cacheRead;
            worker.usage.cacheWrite += delta.cacheWrite;
            if (delta.cost) worker.usage.cost = (worker.usage.cost ?? 0) + delta.cost;
          }
        }
        if (message.role === "assistant") {
          recordEvent(worker, "message", { role: "assistant", text: extractMessageText(event.message) });
        } else if (message.role === "toolResult") {
          const tool = (event.message as { toolName?: string }).toolName ?? "tool";
          recordEvent(worker, "message", { role: "toolResult", tool, text: extractMessageText(event.message) });
        }
        refreshContext(worker);
        break;
      }
      case "compaction_start":
      case "compaction_end": {
        recordEvent(worker, "compaction", event);
        refreshContext(worker);
        break;
      }
      default:
        break;
    }
    notify();
  }

  function settleRun(worker: WorkerRecord, text: string, failure: string | undefined, truncated: boolean): void {
    const context = worker.session?.contextUsage();
    if (context?.tokens !== undefined) worker.contextTokens = context.tokens;
    if (context?.percent !== undefined) worker.contextPercent = context.percent;
    worker.activeTools.clear();
    worker.activity = undefined;
    worker.completedAt = new Date().toISOString();
    if (worker.stopRequested) {
      worker.state = "stopped";
      worker.result = text || undefined;
      worker.error = undefined;
      recordEvent(worker, "run_end", {
        generation: worker.generation,
        outcome: "stopped",
        ...(text ? { result: text } : {}),
      });
    } else if (failure) {
      worker.state = "failed";
      worker.error = failure;
      worker.result = text || undefined;
      recordEvent(worker, "run_end", {
        generation: worker.generation,
        outcome: "failed",
        error: failure,
        ...(text ? { result: text } : {}),
      });
    } else {
      worker.state = "idle";
      worker.result = text;
      worker.error = undefined;
      recordEvent(worker, "run_end", {
        generation: worker.generation,
        outcome: "completed",
        result: text,
        ...(truncated ? { truncated: true } : {}),
      });
    }
  }

  async function runGeneration(worker: WorkerRecord, text: string): Promise<void> {
    const session = worker.session;
    if (!session || worker.disposed) return;
    if (worker.stopRequested) {
      worker.state = "stopped";
      worker.completedAt = new Date().toISOString();
      recordEvent(worker, "run_end", { generation: worker.generation, outcome: "stopped" });
      notify();
      pump();
      return;
    }
    const steers = worker.pendingSteers;
    worker.pendingSteers = [];
    const fullText = steers.length > 0 ? `${text}\n\nAdditional instructions:\n${steers.join("\n")}` : text;
    worker.generation += 1;
    worker.state = "running";
    worker.startedAt = new Date().toISOString();
    worker.error = undefined;
    worker.result = undefined;
    worker.runStartIndex = session.messageCount();
    worker.runBuffer = "";
    worker.genText = "";
    recordEvent(worker, "run_start", { generation: worker.generation, text: fullText });
    let failure: string | undefined;
    try {
      await session.prompt(fullText);
    } catch (error) {
      failure = (error as Error).message || "prompt failed";
    }
    if (worker.disposed) return;
    const messages = session.messages();
    const startIndex = Math.min(worker.runStartIndex, messages.length);
    const collected = worker.genText.trim() || lastAssistantText(messages, startIndex);
    failure = failure ?? finalTurnFailure(messages, startIndex, worker.stopRequested);
    const stopReason = lastStopReason(messages, startIndex);
    settleRun(worker, collected, failure, !failure && stopReason === "length");
    worker.runPromise = undefined;
    notify();
    pump();
  }

  async function doStartup(worker: WorkerRecord, text: string, epoch: number): Promise<void> {
    try {
      const session = await sessionFactory({
        agent: worker.agent,
        model: worker.model,
        workerId: worker.id,
        cwd: worker.cwd,
        thinking: worker.thinking,
        systemPrompt: worker.systemPrompt,
        onEvent: (event) => handleSessionEvent(worker, event),
        onExtensionError: (message) => {
          console.error(`subagent ${worker.id}: ${message}`);
          recordEvent(worker, "extension_error", { message });
        },
      });
      if (epoch !== worker.startupEpoch || worker.stopRequested || worker.disposed) {
        try {
          await session.dispose();
        } catch (error) {
          console.error(`subagent ${worker.id}: late session disposal failed: ${(error as Error).message}`);
        }
        if (!worker.disposed && worker.stopRequested && worker.state === "starting") {
          worker.state = "stopped";
          worker.completedAt = new Date().toISOString();
          recordEvent(worker, "run_end", { generation: worker.generation, outcome: "stopped" });
          notify();
          pump();
        }
        return;
      }
      worker.session = session;
      session.setThinkingLevel(worker.thinking);
      worker.thinking = session.thinkingLevel();
      const run = runGeneration(worker, text);
      worker.runPromise = run;
      await run;
    } catch (error) {
      if (epoch !== worker.startupEpoch || worker.disposed) return;
      if (worker.stopRequested) {
        worker.state = "stopped";
        worker.completedAt = new Date().toISOString();
        recordEvent(worker, "run_end", { generation: worker.generation, outcome: "stopped" });
      } else {
        worker.state = "failed";
        worker.error = (error as Error).message || "startup failed";
        worker.completedAt = new Date().toISOString();
        recordEvent(worker, "run_end", {
          generation: worker.generation,
          outcome: "failed",
          error: worker.error,
        });
      }
      notify();
      pump();
    } finally {
      if (worker.startupEpoch === epoch) worker.startup = undefined;
    }
  }

  function pump(): void {
    if (closed) return;
    let rotated = false;
    while (activeCount() < config.maxConcurrent && queue.length > 0) {
      const item = queue[0];
      const worker = workers.get(item.workerId);
      if (!worker || worker.disposed || worker.stopRequested) {
        queue.shift();
        continue;
      }
      if (worker.runPromise || worker.state === "starting" || worker.state === "running") {
        queue.shift();
        if (rotated) break;
        queue.push(item);
        rotated = true;
        continue;
      }
      rotated = false;
      queue.shift();
      if (!worker.session) {
        if (worker.state !== "queued") continue;
        if (worker.startup) continue;
        worker.state = "starting";
        worker.startupEpoch += 1;
        const epoch = worker.startupEpoch;
        recordEvent(worker, "starting", { agent: worker.agent.name, cwd: worker.cwd });
        worker.startup = doStartup(worker, item.text, epoch);
      } else if (worker.state === "queued") {
        const run = runGeneration(worker, item.text);
        worker.runPromise = run;
        void run;
      }
    }
  }

  function newId(): string {
    let id = "";
    do {
      counter += 1;
      id = `sub-${counter.toString(36)}${randomBytes(3).toString("hex")}`;
    } while (workers.has(id));
    return id;
  }

  async function allocateTranscript(transcriptDir: string | undefined): Promise<{ id: string; transcriptPath?: string; file?: FileHandle }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const id = newId();
      if (!transcriptDir) return { id };
      const transcriptPath = join(transcriptDir, `${id}.jsonl`);
      try {
        const file = await open(transcriptPath, "wx", 0o600);
        return { id, transcriptPath, file };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
      }
    }
    throw new Error("Could not allocate a transcript file");
  }

  async function removeWorker(worker: WorkerRecord): Promise<void> {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].workerId === worker.id) queue.splice(i, 1);
    }
    worker.stopRequested = true;
    try {
      if (worker.runPromise && worker.session) {
        await worker.session.abort().catch(() => {});
      }
      if (worker.startup) await worker.startup;
      if (worker.runPromise) await worker.runPromise;
    } finally {
      try {
        await worker.session?.dispose();
      } catch (error) {
        console.error(`subagent ${worker.id}: session disposal failed: ${(error as Error).message}`);
      }
      worker.session = undefined;
      worker.disposed = true;
      if (worker.file) {
        try {
          await worker.writeChain;
        } finally {
          await worker.file.close().catch(() => {});
          worker.file = undefined;
        }
      }
      workers.delete(worker.id);
    }
    notify();
    pump();
  }

  const service: SubagentWorkerService = {
    async listAgents() {
      assertOpen();
      const agents = await loadAgentDefinitions(config.agentsDir, env.modelRuntime);
      return agents.map((agent) => agent.definition);
    },

    async spawnSubagents(tasks: SubagentSpawnTask[]): Promise<SubagentSpawnOutcome[]> {
      assertOpen();
      const agents = await loadAgentDefinitions(config.agentsDir, env.modelRuntime);
      const byName = new Map(agents.map((agent) => [agent.name, agent]));
      const outcomes: SubagentSpawnOutcome[] = [];
      const pending: Array<{ worker: WorkerRecord; text: string; index: number }> = [];

      for (let index = 0; index < tasks.length; index++) {
        const task = tasks[index];
        try {
          const agent = byName.get(task.agent);
          if (!agent) {
            throw new Error(
              `Unknown agent "${task.agent}". Available: ${agents.map((entry) => entry.name).join(", ") || "(none)"}`,
            );
          }
          if (!task.prompt || task.prompt.trim() === "") throw new Error("Task prompt must be non-empty");
          if (!task.cwd || task.cwd.trim() === "") throw new Error("Task cwd must be non-empty");
          const cwd = task.cwd.startsWith("/") ? task.cwd : resolve(process.cwd(), task.cwd);
          try {
            const info = await stat(cwd);
            if (!info.isDirectory()) throw new Error("not a directory");
          } catch (error) {
            throw new Error(`Task cwd not found: ${cwd} (${(error as Error).message})`);
          }
          const model = env.modelRuntime.getModel(agent.provider, agent.modelId);
          if (!model) throw new Error(`Unknown model "${agent.model}" for agent "${agent.name}"`);
          const levels = supportedThinkingFor(model);
          if (task.thinking !== undefined && !(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(task.thinking)) {
            throw new Error(`Unknown thinking level "${task.thinking}"`);
          }
          if (task.thinking !== undefined && !levels.includes(task.thinking)) {
            throw new Error(
              `Thinking level "${task.thinking}" not supported by ${agent.model}. Supported: ${levels.join(", ") || "(none)"}`
            );
          }
          const requested: SubagentThinkingLevel =
            task.thinking ??
            (agent.defaultThinking ? clampThinkingFor(model, agent.defaultThinking) : pickDefaultThinking(levels));
          const opened = await allocateTranscript(config.transcripts === "disk" ? config.transcriptDir : undefined);
          const id = opened.id;
          const worker: WorkerRecord = {
            id,
            agent,
            model,
            cwd,
            description: task.description ?? task.prompt.slice(0, 120),
            thinking: requested,
            pendingSteers: [],
            state: "queued",
            generation: 0,
            turns: 0,
            toolUses: 0,
            activeTools: new Map(),
            createdAt: new Date().toISOString(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            ...(opened.transcriptPath ? { transcriptPath: opened.transcriptPath } : {}),
            events: [],
            cursor: 0,
            systemPrompt: buildSystemPrompt(commonPrompt, agent, cwd),
            startupEpoch: 0,
            stopRequested: false,
            runStartIndex: 0,
            runBuffer: "",
            genText: "",
            initialText: task.prompt,
            ...(opened.file ? { file: opened.file } : {}),
            writeChain: Promise.resolve(),
            disposed: false,
          };
          workers.set(id, worker);
          recordEvent(worker, "created", { agent: agent.name, cwd, description: worker.description });
          pending.push({ worker, text: task.prompt, index });
        } catch (error) {
          outcomes.push({ index, success: false, error: (error as Error).message });
        }
      }

      for (const item of pending) {
        queue.push({ workerId: item.worker.id, text: item.text });
        outcomes.push({ index: item.index, success: true, worker: snapshot(item.worker) });
      }
      outcomes.sort((a, b) => a.index - b.index);
      pump();
      for (const item of pending) {
        const outcome = outcomes.find((entry) => entry.index === item.index);
        if (outcome?.worker) outcome.worker = snapshot(item.worker);
      }
      return outcomes;
    },

    listSubagents(): SubagentSnapshot[] {
      return [...workers.values()].map(snapshot);
    },

    inspectSubagent(id: string, cursor = 0, limit = 200): SubagentInspection {
      const worker = requireWorker(id);
      const safeLimit = Math.min(Math.max(Math.floor(limit) || 200, 1), 1000);
      const firstAvailableCursor = worker.events[0]?.cursor ?? worker.cursor + 1;
      const events = worker.events.filter((event) => event.cursor > cursor).slice(0, safeLimit);
      return {
        worker: snapshot(worker),
        events,
        nextCursor: events.length > 0 ? events[events.length - 1].cursor : cursor,
        firstAvailableCursor,
        historyTruncated: cursor < firstAvailableCursor - 1,
      };
    },

    async sendSubagent(id: string, message: string): Promise<SubagentSnapshot> {
      assertOpen();
      const worker = requireWorker(id);
      if (!message || message.trim() === "") throw new Error("Message must be non-empty");
      if (worker.runPromise && worker.session && !worker.stopRequested) {
        try {
          await worker.session.steer(message);
        } catch (error) {
          if (worker.stopRequested) throw new Error(`Subagent "${id}" is stopped`);
          throw error;
        }
        return snapshot(worker);
      }
      if (worker.stopRequested && (worker.state === "starting" || worker.state === "running")) {
        throw new Error(`Subagent "${id}" is stopping`);
      }
      if (worker.state === "queued") {
        worker.pendingSteers.push(message);
        return snapshot(worker);
      }
      if (!worker.session) {
        if (worker.state === "starting") {
          worker.pendingSteers.push(message);
          return snapshot(worker);
        }
        if (worker.state !== "stopped" && worker.state !== "failed") {
          throw new Error(`Subagent "${id}" never started; spawn a new subagent`);
        }
        worker.stopRequested = false;
        worker.error = undefined;
        worker.result = undefined;
        worker.state = "queued";
        worker.pendingSteers.push(message);
        if (!worker.startup) queue.push({ workerId: worker.id, text: worker.initialText });
        pump();
        return snapshot(worker);
      }
      if (worker.state !== "idle" && worker.state !== "stopped" && worker.state !== "failed") {
        throw new Error(`Subagent "${id}" is ${worker.state}`);
      }
      worker.stopRequested = false;
      worker.error = undefined;
      worker.result = undefined;
      worker.state = "queued";
      queue.push({ workerId: worker.id, text: message });
      pump();
      return snapshot(worker);
    },

    async configureSubagent(id: string, thinking: SubagentThinkingLevel): Promise<SubagentSnapshot> {
      assertOpen();
      const worker = requireWorker(id);
      if (!(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(thinking)) {
        throw new Error(`Unknown thinking level "${thinking}"`);
      }
      const levels = supportedThinkingFor(worker.model);
      if (!levels.includes(thinking)) {
        throw new Error(
          `Thinking level "${thinking}" not supported by ${worker.agent.model}. Supported: ${levels.join(", ") || "(none)"}`,
        );
      }
      if (worker.session) {
        worker.session.setThinkingLevel(thinking);
        worker.thinking = worker.session.thinkingLevel();
      } else {
        worker.thinking = thinking;
      }
      notify();
      return snapshot(worker);
    },

    async stopSubagents(ids: string[]): Promise<SubagentOperationOutcome[]> {
      assertOpen();
      const outcomes: SubagentOperationOutcome[] = [];
      const settling: Promise<void>[] = [];
      for (const id of ids) {
        try {
          const worker = requireWorker(id);
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].workerId === id) queue.splice(i, 1);
          }
          worker.pendingSteers = [];
          if (isTerminalState(worker.state) && !worker.runPromise) {
            outcomes.push({ id, success: true, worker: snapshot(worker) });
            continue;
          }
          worker.stopRequested = true;
          const abort = worker.session
            ? worker.session.abort().catch(() => {})
            : Promise.resolve();
          if (worker.runPromise) settling.push(worker.runPromise.catch(() => {}));
          settling.push(abort);
          if (worker.state === "queued" || (worker.state === "starting" && !worker.session)) {
            worker.state = "stopped";
            worker.completedAt = new Date().toISOString();
            recordEvent(worker, "run_end", { generation: worker.generation, outcome: "stopped" });
          }
          outcomes.push({ id, success: true, worker: snapshot(worker) });
        } catch (error) {
          outcomes.push({ id, success: false, error: (error as Error).message });
        }
      }
      notify();
      pump();
      await Promise.all(settling);
      return ids.map((id) => {
        const existing = outcomes.find((entry) => entry.id === id);
        if (!existing) return { id, success: false, error: "missing outcome" };
        const worker = workers.get(id);
        if (worker && existing.success) existing.worker = snapshot(worker);
        return existing;
      });
    },

    async waitSubagents(
      ids: string[],
      type: "any" | "all",
      timeoutSeconds?: number,
      signal?: AbortSignal,
    ): Promise<SubagentWaitResult> {
      assertOpen();
      if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0)) {
        throw new Error("timeoutSeconds must be a finite number >= 0");
      }
      const check = (): SubagentWaitResult => {
        const selected = ids.map(requireWorker);
        const finished = selected.filter((worker) => isTerminalState(worker.state)).map(snapshot);
        const pending = selected.filter((worker) => !isTerminalState(worker.state)).map(snapshot);
        return { finished, pending, timedOut: false };
      };
      const done = (result: SubagentWaitResult): boolean =>
        type === "any"
          ? result.finished.length > 0 || result.pending.length === 0
          : result.pending.length === 0;
      const initial = check();
      if (done(initial)) return initial;
      return new Promise<SubagentWaitResult>((resolvePromise, rejectPromise) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const waiter: Waiter = {
          ids: new Set(ids),
          type,
          settle: () => {
            let current: SubagentWaitResult;
            try {
              current = check();
            } catch (error) {
              cleanup();
              rejectPromise(error);
              return;
            }
            if (done(current)) {
              cleanup();
              resolvePromise(current);
            }
          },
          cancel: (error: Error) => {
            cleanup();
            rejectPromise(error);
          },
        };
        const cleanup = (): void => {
          waiters.delete(waiter);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        const onAbort = (): void => {
          cleanup();
          rejectPromise(abortError());
        };
        if (signal?.aborted) {
          rejectPromise(abortError());
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (timeoutSeconds !== undefined) {
          timer = setTimeout(() => {
            cleanup();
            const current = check();
            resolvePromise({ ...current, timedOut: !done(current) });
          }, timeoutSeconds * 1000);
        }
        waiters.add(waiter);
      });
    },

    getSubagentResults(ids: string[]): SubagentOperationOutcome[] {
      return ids.map((id) => {
        try {
          const worker = requireWorker(id);
          if (worker.state === "idle") return { id, success: true, worker: snapshot(worker) };
          if (worker.state === "failed") {
            return { id, success: false, worker: snapshot(worker), error: worker.error ?? "worker failed" };
          }
          if (worker.state === "stopped") {
            return { id, success: false, worker: snapshot(worker), error: worker.error ?? "worker stopped" };
          }
          return { id, success: false, worker: snapshot(worker), error: `worker is ${worker.state}` };
        } catch (error) {
          return { id, success: false, error: (error as Error).message };
        }
      });
    },

    async releaseSubagents(ids: string[], force = false): Promise<SubagentOperationOutcome[]> {
      assertOpen();
      const outcomes: SubagentOperationOutcome[] = [];
      for (const id of ids) {
        try {
          const worker = requireWorker(id);
          const active =
            worker.state === "queued" ||
            worker.state === "starting" ||
            worker.state === "running" ||
            worker.runPromise !== undefined;
          if (active && !force) {
            outcomes.push({ id, success: false, worker: snapshot(worker), error: `Subagent "${id}" is ${worker.state}; pass force to stop and release it` });
            continue;
          }
          recordEvent(worker, "released", { force });
          await removeWorker(worker);
          outcomes.push({ id, success: true });
        } catch (error) {
          outcomes.push({ id, success: false, error: (error as Error).message });
        }
      }
      return outcomes;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      queue.length = 0;
      const pendingWaiters = [...waiters];
      waiters.clear();
      for (const waiter of pendingWaiters) {
        waiter.cancel(new Error("Subagent service is closed"));
      }
      const all = [...workers.values()];
      for (const worker of all) {
        worker.stopRequested = true;
        try {
          if (worker.session) await worker.session.abort().catch(() => {});
        } catch (error) {
          console.error(`subagent ${worker.id}: abort during shutdown failed: ${(error as Error).message}`);
        }
      }
      for (const worker of all) {
        try {
          if (worker.startup) await worker.startup;
          if (worker.runPromise) await worker.runPromise;
        } catch (error) {
          console.error(`subagent ${worker.id}: settle during shutdown failed: ${(error as Error).message}`);
        }
      }
      for (const worker of all) {
        try {
          await worker.session?.dispose();
        } catch (error) {
          console.error(`subagent ${worker.id}: session disposal failed: ${(error as Error).message}`);
        }
        worker.session = undefined;
        worker.disposed = true;
        if (worker.file) {
          try {
            await worker.writeChain;
          } finally {
            await worker.file.close().catch(() => {});
            worker.file = undefined;
          }
        }
        workers.delete(worker.id);
      }
      listeners.clear();
      notify();
    },
  };

  return service;
}
