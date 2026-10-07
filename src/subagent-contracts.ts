export type SubagentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type SubagentState = "queued" | "starting" | "running" | "idle" | "stopped" | "failed";

export type SubagentTranscriptMode = "memory" | "disk";

export interface SubagentServiceConfig {
  agentsDir: string;
  skillsDir: string;
  workerInstructionsFile: string;
  piAgentDir: string;
  excludeExtensions: string[];
  port: number;
  maxConcurrent: number;
  transcriptDir: string;
  transcripts: SubagentTranscriptMode;
}

export interface SubagentDefinition {
  name: string;
  description: string;
  model: string;
  defaultThinking?: SubagentThinkingLevel;
  supportedThinking: SubagentThinkingLevel[];
}

export interface SubagentSpawnTask {
  agent: string;
  prompt: string;
  cwd: string;
  description?: string;
  thinking?: SubagentThinkingLevel;
}

export interface SubagentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: number;
}

export interface SubagentSnapshot {
  id: string;
  agent: string;
  description: string;
  model: string;
  thinking: SubagentThinkingLevel;
  cwd: string;
  state: SubagentState;
  generation: number;
  turns: number;
  toolUses: number;
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
  initialPrompt: string;
}

export interface SubagentTranscriptEvent {
  cursor: number;
  timestamp: string;
  type: string;
  data: unknown;
}

export interface SubagentInspection {
  worker: SubagentSnapshot;
  events: SubagentTranscriptEvent[];
  nextCursor: number;
  firstAvailableCursor?: number;
  historyTruncated?: boolean;
}

export interface SubagentOperationOutcome {
  id: string;
  success: boolean;
  worker?: SubagentSnapshot;
  error?: string;
}

export interface SubagentSpawnOutcome {
  index: number;
  success: boolean;
  worker?: SubagentSnapshot;
  error?: string;
}

export interface SubagentWaitResult {
  finished: SubagentSnapshot[];
  pending: SubagentSnapshot[];
  timedOut: boolean;
}

export interface SubagentWorkerService {
  listAgents(): Promise<SubagentDefinition[]>;
  spawnSubagents(tasks: SubagentSpawnTask[]): Promise<SubagentSpawnOutcome[]>;
  listSubagents(): SubagentSnapshot[];
  inspectSubagent(id: string, cursor?: number, limit?: number): SubagentInspection;
  sendSubagent(id: string, message: string): Promise<SubagentSnapshot>;
  configureSubagent(id: string, thinking: SubagentThinkingLevel): Promise<SubagentSnapshot>;
  stopSubagents(ids: string[]): Promise<SubagentOperationOutcome[]>;
  waitSubagents(ids: string[], type: "any" | "all", timeoutSeconds?: number, signal?: AbortSignal): Promise<SubagentWaitResult>;
  getSubagentResults(ids: string[]): SubagentOperationOutcome[];
  releaseSubagents(ids: string[], force?: boolean): Promise<SubagentOperationOutcome[]>;
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}
