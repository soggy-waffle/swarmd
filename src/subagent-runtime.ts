import { readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultPackageManager,
  DefaultResourceLoader,
  initTheme,
  loadSkillsFromDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type Skill,
} from "@earendil-works/pi-coding-agent";
export type AgentMessage = AgentSession["messages"][number];
import type { SubagentServiceConfig, SubagentThinkingLevel } from "./subagent-contracts.js";
import { loadAgentDefinitions, type ParsedSubagentAgent, type ResolvedSubagentAgent } from "./subagent-definitions.js";

export interface WorkerSessionSpec {
  agent: ResolvedSubagentAgent;
  model: Model<Api>;
  workerId: string;
  cwd: string;
  thinking: SubagentThinkingLevel;
  systemPrompt: string;
  onEvent: (event: AgentSessionEvent) => void;
  onExtensionError: (message: string) => void;
}

export interface PiSessionHandle {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  setThinkingLevel(level: SubagentThinkingLevel): void;
  thinkingLevel(): SubagentThinkingLevel;
  availableThinking(): SubagentThinkingLevel[];
  messageCount(): number;
  messages(): AgentMessage[];
  activeToolNames(): string[];
  skillNames(): string[];
  contextUsage(): { tokens?: number; percent?: number };
}

export type PiSessionFactory = (spec: WorkerSessionSpec) => Promise<PiSessionHandle>;

export interface WorkerRuntimeEnv {
  config: SubagentServiceConfig;
  modelRuntime: ModelRuntime;
  settingsManager: SettingsManager;
  loaderRoot: string;
  allowedExtensionPaths: string[];
  deniedExtensionPaths: string[];
}

export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  if (base === "index.ts" || base === "index.js") return basename(dirname(extPath)).toLowerCase();
  return base.replace(/\.(ts|js)$/, "").toLowerCase();
}

export function extensionPackageShortName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
      continue;
    }
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

export function extensionNamesForPath(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageShortName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

export function filterDeniedExtensions(
  paths: string[],
  denylist: string[],
): { allowed: string[]; denied: string[] } {
  const deniedNames = new Set(denylist.map((name) => name.toLowerCase()));
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const path of paths) {
    if (path.startsWith("builtin:")) {
      denied.push(path);
      continue;
    }
    const names = extensionNamesForPath(path);
    if (names.some((name) => deniedNames.has(name))) denied.push(path);
    else allowed.push(path);
  }
  return { allowed, denied };
}

export function buildSystemPrompt(
  commonInstructions: string,
  agent: Pick<ParsedSubagentAgent, "name" | "body">,
  cwd: string,
): string {
  return (
    `<active_agent name="${agent.name}"/>\n\n` +
    `You are a pi coding agent sub-agent. Handle the supplied task autonomously in the working directory.\n\n` +
    `# Environment\nWorking directory: ${cwd}\nPlatform: ${platform()}\n\n` +
    `# Shared worker instructions\n${commonInstructions.trim()}\n\n` +
    `# Agent instructions\n${agent.body.trim()}`
  );
}

export function extractMessageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block?.type === "text" && typeof block.text === "string" && block.text) parts.push(block.text);
  }
  return parts.join("\n");
}

export function lastAssistantText(messages: AgentMessage[], fromIndex: number): string {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const message = messages[i] as { role?: string };
    if (message.role !== "assistant") continue;
    const text = extractMessageText(messages[i]).trim();
    if (text) return text;
  }
  return "";
}

export function finalTurnFailure(
  messages: AgentMessage[],
  fromIndex: number,
  wasStopped = false,
): string | undefined {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const message = messages[i] as { role?: string; stopReason?: string; errorMessage?: string };
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      const detail = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
      return detail || "provider error with no output";
    }
    if (message.stopReason === "aborted" && !wasStopped) {
      return "run was aborted before producing a result";
    }
    if (message.stopReason === "length" && !extractMessageText(messages[i]).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

export function lastStopReason(messages: AgentMessage[], fromIndex: number): string | undefined {
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const message = messages[i] as { role?: string; stopReason?: string };
    if (message.role !== "assistant") continue;
    return message.stopReason;
  }
  return undefined;
}

export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export function usageOfMessage(message: AgentMessage): UsageDelta | undefined {
  const usage = (message as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (key: string): number => (typeof usage[key] === "number" ? (usage[key] as number) : 0);
  const cost = usage["cost"];
  const total =
    cost && typeof cost === "object" && typeof (cost as Record<string, unknown>)["total"] === "number"
      ? ((cost as Record<string, unknown>)["total"] as number)
      : 0;
  if (!num("input") && !num("output") && !num("cacheRead") && !num("cacheWrite") && !total) return undefined;
  return { input: num("input"), output: num("output"), cacheRead: num("cacheRead"), cacheWrite: num("cacheWrite"), cost: total };
}

export async function initWorkerRuntimeEnv(
  config: SubagentServiceConfig,
  modelRuntime?: ModelRuntime,
): Promise<WorkerRuntimeEnv> {
  initTheme("dark", false);
  const runtime =
    modelRuntime ??
    (await ModelRuntime.create({
      authPath: join(config.piAgentDir, "auth.json"),
      modelsPath: join(config.piAgentDir, "models.json"),
    }));
  const loaderRoot = resolve(join(config.transcriptDir, "..", ".swarmd-loader-root"));
  await mkdir(loaderRoot, { recursive: true, mode: 0o700 });
  const settingsManager = SettingsManager.create(loaderRoot, config.piAgentDir);
  const packageManager = new DefaultPackageManager({
    cwd: loaderRoot,
    agentDir: config.piAgentDir,
    settingsManager,
    builtinExtensions: [],
  });
  const resolved = await packageManager.resolve(async () => "skip");
  const discovered = resolved.extensions.filter((entry) => entry.enabled).map((entry) => entry.path);
  const { allowed, denied } = filterDeniedExtensions(discovered, config.excludeExtensions);
  return { config, modelRuntime: runtime, settingsManager, loaderRoot, allowedExtensionPaths: allowed, deniedExtensionPaths: denied };
}

export async function loadWorkerAgent(
  env: WorkerRuntimeEnv,
  name: string,
): Promise<ResolvedSubagentAgent> {
  const agents = await loadAgentDefinitions(env.config.agentsDir, env.modelRuntime);
  const agent = agents.find((entry) => entry.name === name);
  if (!agent) {
    throw new Error(
      `Unknown agent "${name}". Available: ${agents.map((entry) => entry.name).join(", ") || "(none)"}`,
    );
  }
  return agent;
}

export async function readCommonInstructions(config: SubagentServiceConfig): Promise<string> {
  try {
    return (await readFile(config.workerInstructionsFile, "utf8")).trim();
  } catch (error) {
    throw new Error(
      `Cannot read worker instructions at ${config.workerInstructionsFile} (${(error as Error).message})`,
    );
  }
}

function extensionActiveToolNames(loader: DefaultResourceLoader): string[] {
  const names = new Set<string>();
  for (const extension of loader.getExtensions().extensions) {
    for (const [name, tool] of extension.tools) {
      const exposure = tool.definition.exposure ?? "direct";
      if (exposure === "direct" || exposure === "model-only") names.add(name);
    }
  }
  return [...names];
}

function activateNewTools(session: AgentSession, loader: DefaultResourceLoader): void {
  const active = new Set(session.getActiveToolNames());
  const next = extensionActiveToolNames(loader).filter((name) => !active.has(name));
  if (next.length > 0) session.setActiveToolsByName([...active, ...next]);
}

export function wrapSession(session: AgentSession, loaderSkills: () => Skill[]): PiSessionHandle {
  let disposePromise: Promise<void> | undefined;
  return {
    prompt: (text: string) => session.prompt(text),
    steer: async (text: string) => {
      await session.steer(text);
    },
    followUp: async (text: string) => {
      await session.followUp(text);
    },
    abort: async () => {
      try {
        session.clearQueue();
      } finally {
        await session.abort();
      }
    },
    dispose: () => {
      if (!disposePromise) {
        disposePromise = (async () => {
          try {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          } catch (error) {
            console.error(`session shutdown emit failed: ${(error as Error).message}`);
          } finally {
            session.dispose();
          }
        })();
      }
      return disposePromise;
    },
    setThinkingLevel: (level: SubagentThinkingLevel) => {
      session.setThinkingLevel(level);
    },
    thinkingLevel: () => session.thinkingLevel as SubagentThinkingLevel,
    availableThinking: () => session.getAvailableThinkingLevels() as SubagentThinkingLevel[],
    messageCount: () => session.messages.length,
    messages: () => session.messages,
    activeToolNames: () => session.getActiveToolNames(),
    skillNames: () => loaderSkills().map((skill) => skill.name),
    contextUsage: () => {
      const usage = session.getContextUsage();
      if (!usage) return {};
      return {
        ...(usage.tokens != null ? { tokens: usage.tokens } : {}),
        ...(usage.percent != null ? { percent: usage.percent } : {}),
      };
    },
  };
}

export function createRealSessionFactory(env: WorkerRuntimeEnv): PiSessionFactory {
  const { config } = env;
  const includeCodemode = !config.excludeExtensions.map((name) => name.toLowerCase()).includes("codemode");
  return async (spec: WorkerSessionSpec): Promise<PiSessionHandle> => {
    const skills = loadSkillsFromDir({ dir: config.skillsDir, source: "user" });
    const loader = new DefaultResourceLoader({
      cwd: env.loaderRoot,
      agentDir: config.piAgentDir,
      settingsManager: env.settingsManager,
      noExtensions: true,
      additionalExtensionPaths: env.allowedExtensionPaths,
      extensionFactories: includeCodemode ? [createCodemodeExtension()] : [],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: () => ({ skills: skills.skills, diagnostics: skills.diagnostics }),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      systemPromptOverride: () => spec.systemPrompt,
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    for (const error of loader.getExtensions().errors) {
      const message = `extension load ${error.path}: ${error.error}`;
      spec.onExtensionError(message);
    }
    if (!isAbsolute(spec.cwd)) throw new Error(`Worker cwd must be absolute: ${spec.cwd}`);
    const { session } = await createAgentSession({
      cwd: spec.cwd,
      agentDir: config.piAgentDir,
      modelRuntime: env.modelRuntime,
      model: spec.model,
      thinkingLevel: spec.thinking,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(spec.cwd),
      settingsManager: env.settingsManager,
    });
    try {
      session.setSessionName(`subagent:${spec.agent.name}#${spec.workerId}`);
      await session.bindExtensions({
        mode: "print",
        onError: (error) => {
          spec.onExtensionError(`extension runtime ${error.extensionPath}: ${error.error}`);
        },
      });
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...extensionActiveToolNames(loader)])]);
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "turn_end") {
          try {
            activateNewTools(session, loader);
          } catch (error) {
            spec.onExtensionError(`tool activation failed: ${(error as Error).message}`);
          }
        }
        spec.onEvent(event);
      });
      const handle = wrapSession(session, () => loader.getSkills().skills);
      const rawDispose = handle.dispose.bind(handle);
      handle.dispose = async () => {
        try {
          unsubscribe();
        } finally {
          await rawDispose();
        }
      };
      return handle;
    } catch (error) {
      try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } catch (shutdownError) {
        console.error(`session shutdown emit after failed init failed: ${(shutdownError as Error).message}`);
      }
      try {
        session.dispose();
      } catch (disposeError) {
        console.error(`session disposal after failed init failed: ${(disposeError as Error).message}`);
      }
      throw error;
    }
  };
}

