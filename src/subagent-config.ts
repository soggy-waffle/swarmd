import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentServiceConfig } from "./subagent-contracts.js";

export interface SubagentConfigOverrides {
  port?: number;
  maxConcurrent?: number;
}

const KNOWN_FIELDS = new Set([
  "agentsDir",
  "skillsDir",
  "workerInstructionsFile",
  "piAgentDir",
  "excludeExtensions",
  "port",
  "maxConcurrent",
  "transcriptDir",
  "transcripts",
]);

const DEFAULT_EXCLUDE = ["mcp"];

export function defaultConfigDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "swarmd");
}

function expandPath(value: string, baseDir: string): string {
  let out = value;
  if (out === "~" || out.startsWith("~/")) out = join(homedir(), out.slice(2));
  if (!isAbsolute(out)) out = resolve(baseDir, out);
  return out;
}

function configError(file: string, message: string): Error {
  return new Error(`Invalid subagent config at ${file}: ${message}`);
}

function readString(raw: Record<string, unknown>, file: string, field: string): string | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw configError(file, `"${field}" must be a non-empty string`);
  }
  return value;
}

function readPort(raw: Record<string, unknown>, file: string, field: string): number | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw configError(file, `"${field}" must be an integer port 1-65535`);
  }
  return value;
}

function readMaxConcurrent(raw: Record<string, unknown>, file: string, field: string): number | undefined {
  const value = raw[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw configError(file, `"${field}" must be an integer >= 1`);
  }
  return value;
}

function readExcludeExtensions(raw: Record<string, unknown>, file: string): string[] | undefined {
  const value = raw["excludeExtensions"];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw configError(file, `"excludeExtensions" must be an array of non-empty strings`);
  }
  return (value as string[]).map((entry) => entry.trim().toLowerCase());
}

async function mustBeDir(path: string, file: string, field: string, hint: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("not a directory");
  } catch (error) {
    throw configError(
      file,
      `"${field}" directory not found: ${path}. ${hint} (${(error as Error).message})`,
    );
  }
}

async function mustBeFile(path: string, file: string, field: string, hint: string): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
  } catch (error) {
    throw configError(
      file,
      `"${field}" file not found: ${path}. ${hint} (${(error as Error).message})`,
    );
  }
}

export async function loadSubagentConfig(
  configPath?: string,
  overrides?: SubagentConfigOverrides,
): Promise<SubagentServiceConfig> {
  const file = configPath
    ? expandPath(configPath, process.cwd())
    : join(defaultConfigDir(), "config.json");
  const fileDir = dirname(file);

  let raw: Record<string, unknown> = {};
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("top-level JSON value must be an object");
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !configPath) {
      raw = {};
    } else {
      throw configError(file, `cannot load config file (${(error as Error).message})`);
    }
  }

  const unknown = Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0) {
    throw configError(file, `unknown field(s): ${unknown.join(", ")}. Known fields: ${[...KNOWN_FIELDS].join(", ")}`);
  }

  if (overrides?.port !== undefined) {
    if (!Number.isInteger(overrides.port) || overrides.port < 1 || overrides.port > 65535) {
      throw configError(file, `override "port" must be an integer port 1-65535`);
    }
  }
  if (overrides?.maxConcurrent !== undefined) {
    if (!Number.isInteger(overrides.maxConcurrent) || overrides.maxConcurrent < 1) {
      throw configError(file, `override "maxConcurrent" must be an integer >= 1`);
    }
  }

  const agentsDir = expandPath(readString(raw, file, "agentsDir") ?? join(fileDir, "agents"), fileDir);
  const skillsDir = expandPath(readString(raw, file, "skillsDir") ?? join(homedir(), ".agents", "skills"), fileDir);
  const workerInstructionsFile = expandPath(
    readString(raw, file, "workerInstructionsFile") ?? join(fileDir, "SUBAGENT_INSTRUCTIONS.md"),
    fileDir,
  );
  const piAgentDir = expandPath(readString(raw, file, "piAgentDir") ?? getAgentDir(), fileDir);
  const transcriptDir = expandPath(
    readString(raw, file, "transcriptDir") ?? join(fileDir, "transcripts"),
    fileDir,
  );
  const transcripts = readString(raw, file, "transcripts") ?? "memory";
  if (transcripts !== "memory" && transcripts !== "disk") {
    throw configError(file, `"transcripts" must be "memory" or "disk" (received "${transcripts}")`);
  }

  await mustBeDir(
    agentsDir,
    file,
    "agentsDir",
    `Create it with one .md file per agent, or point "agentsDir" at the directory in ${file}`,
  );
  await mustBeDir(
    skillsDir,
    file,
    "skillsDir",
    `Explicit skillsDir is the only skills source; create it or point "skillsDir" at it in ${file}`,
  );
  await mustBeDir(
    piAgentDir,
    file,
    "piAgentDir",
    `Pi credentials, models, settings, and extensions load from here; point "piAgentDir" at the Pi global directory in ${file}`,
  );
  await mustBeFile(
    workerInstructionsFile,
    file,
    "workerInstructionsFile",
    `Create the shared worker instructions file, or point "workerInstructionsFile" at it in ${file}`,
  );

  if (transcripts === "disk") await mkdir(transcriptDir, { recursive: true, mode: 0o700 });

  return {
    agentsDir,
    skillsDir,
    workerInstructionsFile,
    piAgentDir,
    excludeExtensions: readExcludeExtensions(raw, file) ?? [...DEFAULT_EXCLUDE],
    port: overrides?.port ?? readPort(raw, file, "port") ?? 8787,
    maxConcurrent: overrides?.maxConcurrent ?? readMaxConcurrent(raw, file, "maxConcurrent") ?? 10,
    transcriptDir,
    transcripts,
  };
}
