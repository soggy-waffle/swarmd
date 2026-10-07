import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { parseFrontmatter, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SubagentDefinition, SubagentThinkingLevel } from "./subagent-contracts.js";

export const SUBAGENT_THINKING_LEVELS: readonly SubagentThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface ParsedSubagentAgent {
  name: string;
  description: string;
  model: string;
  provider: string;
  modelId: string;
  defaultThinking?: SubagentThinkingLevel;
  body: string;
  filePath: string;
}

export interface ResolvedSubagentAgent extends ParsedSubagentAgent {
  definition: SubagentDefinition;
}

const KNOWN_AGENT_FIELDS = new Set(["description", "model", "thinking", "prompt_mode", "max_turns"]);

function agentError(filePath: string, message: string): Error {
  return new Error(`Invalid agent file ${filePath}: ${message}`);
}

function readOptionalString(
  fm: Record<string, unknown>,
  filePath: string,
  field: string,
): string | undefined {
  const value = fm[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw agentError(filePath, `"${field}" must be a string`);
  return value;
}

export function parseAgentFile(name: string, content: string, filePath: string): ParsedSubagentAgent {
  const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
  const fm = frontmatter ?? {};
  const unknown = Object.keys(fm).filter((key) => !KNOWN_AGENT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw agentError(filePath, `unknown frontmatter field(s): ${unknown.join(", ")}`);
  }

  const description = readOptionalString(fm, filePath, "description");
  if (!description || description.trim() === "") {
    throw agentError(filePath, `"description" is required and must be non-empty`);
  }
  const model = readOptionalString(fm, filePath, "model");
  if (!model || model.trim() === "") {
    throw agentError(filePath, `"model" is required as "provider/id"`);
  }
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash).trim();
  const modelId = model.slice(slash + 1).trim();
  if (slash === -1 || !provider || !modelId) {
    throw agentError(filePath, `"model" must be "provider/id", got "${model}"`);
  }

  const thinkingRaw = readOptionalString(fm, filePath, "thinking");
  let defaultThinking: SubagentThinkingLevel | undefined;
  if (thinkingRaw !== undefined) {
    const level = thinkingRaw.trim() as SubagentThinkingLevel;
    if (!(SUBAGENT_THINKING_LEVELS as readonly string[]).includes(level)) {
      throw agentError(
        filePath,
        `"thinking" must be one of ${SUBAGENT_THINKING_LEVELS.join(", ")}, got "${thinkingRaw}"`,
      );
    }
    defaultThinking = level;
  }

  if (fm["prompt_mode"] !== undefined && fm["prompt_mode"] !== "replace") {
    throw agentError(filePath, `"prompt_mode" only supports "replace"`);
  }
  if (fm["max_turns"] !== undefined && fm["max_turns"] !== 0) {
    throw agentError(filePath, `"max_turns" only supports 0 (unlimited)`);
  }

  const text = body.trim();
  if (!text) throw agentError(filePath, "agent body must contain system instructions");

  return { name, description, model: `${provider}/${modelId}`, provider, modelId, defaultThinking, body: text, filePath };
}

export function supportedThinkingFor(model: Model<Api>): SubagentThinkingLevel[] {
  return getSupportedThinkingLevels(model) as SubagentThinkingLevel[];
}

export function clampThinkingFor(model: Model<Api>, level: SubagentThinkingLevel): SubagentThinkingLevel {
  return clampThinkingLevel(model, level) as SubagentThinkingLevel;
}

export function resolveAgentDefinition(
  runtime: ModelRuntime,
  parsed: ParsedSubagentAgent,
): ResolvedSubagentAgent {
  const model = runtime.getModel(parsed.provider, parsed.modelId);
  if (!model) {
    throw new Error(
      `Unknown model "${parsed.model}" for agent "${parsed.name}" in ${parsed.filePath}: ` +
        `check provider/id spelling, models.json, and pi auth`,
    );
  }
  const supportedThinking = supportedThinkingFor(model);
  return {
    ...parsed,
    definition: {
      name: parsed.name,
      description: parsed.description,
      model: parsed.model,
      defaultThinking: parsed.defaultThinking,
      supportedThinking,
    },
  };
}

export async function loadAgentDefinitions(
  agentsDir: string,
  runtime?: ModelRuntime,
): Promise<ResolvedSubagentAgent[]> {
  let files: string[];
  try {
    files = (await readdir(agentsDir)).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    throw new Error(`Cannot read agents directory ${agentsDir} (${(error as Error).message})`);
  }
  const agents: ResolvedSubagentAgent[] = [];
  for (const file of files) {
    const name = basename(file, ".md");
    if (!name) throw new Error(`Invalid agent filename ${join(agentsDir, file)}`);
    const filePath = join(agentsDir, file);
    const content = await readFile(filePath, "utf8");
    const parsed = parseAgentFile(name, content, filePath);
    if (runtime) {
      agents.push(resolveAgentDefinition(runtime, parsed));
    } else {
      agents.push({
        ...parsed,
        definition: {
          name: parsed.name,
          description: parsed.description,
          model: parsed.model,
          defaultThinking: parsed.defaultThinking,
          supportedThinking: [...SUBAGENT_THINKING_LEVELS],
        },
      });
    }
  }
  return agents;
}
