import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfigDir, loadSubagentConfig } from "./subagent-config.js";

async function makeDirs(base: string): Promise<{ agentsDir: string; skillsDir: string; piAgentDir: string; instructions: string }> {
  const agentsDir = join(base, "agents");
  const skillsDir = join(base, "skills");
  const piAgentDir = join(base, "pi");
  await Promise.all([mkdir(agentsDir, { recursive: true }), mkdir(skillsDir, { recursive: true }), mkdir(piAgentDir, { recursive: true })]);
  const instructions = join(base, "SUBAGENT_INSTRUCTIONS.md");
  await writeFile(instructions, "common\n");
  return { agentsDir, skillsDir, piAgentDir, instructions };
}

test("defaults apply with explicit skills/agent/instruction roots", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  try {
    const dirs = await makeDirs(base);
    const configPath = join(base, "config.json");
    await writeFile(configPath, JSON.stringify({ skillsDir: dirs.skillsDir, piAgentDir: dirs.piAgentDir }));
    const config = await loadSubagentConfig(configPath);
    assert.equal(config.port, 8787);
    assert.equal(config.maxConcurrent, 10);
    assert.deepEqual(config.excludeExtensions, ["pi-subagents", "mcp"]);
    assert.equal(config.agentsDir, dirs.agentsDir);
    assert.equal(config.skillsDir, dirs.skillsDir);
    assert.equal(config.piAgentDir, dirs.piAgentDir);
    assert.ok(config.transcriptDir.endsWith("transcripts"));
    assert.equal(config.transcripts, "memory");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("unknown fields and invalid values are rejected", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  try {
    await makeDirs(base);
    const configPath = join(base, "config.json");
    await writeFile(configPath, JSON.stringify({ bogus: 1 }));
    await assert.rejects(loadSubagentConfig(configPath), /unknown field\(s\): bogus/);
    await writeFile(configPath, JSON.stringify({ port: 99999 }));
    await assert.rejects(loadSubagentConfig(configPath), /port/);
    await writeFile(configPath, JSON.stringify({ maxConcurrent: 0 }));
    await assert.rejects(loadSubagentConfig(configPath), /maxConcurrent/);
    await writeFile(configPath, JSON.stringify({ excludeExtensions: ["ok", 3] }));
    await assert.rejects(loadSubagentConfig(configPath), /excludeExtensions/);
    await assert.rejects(loadSubagentConfig(configPath, { port: -1 }), /port/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("missing agents/skills/instructions/piAgentDir produce actionable errors", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  try {
    const dirs = await makeDirs(base);
    const configPath = join(base, "config.json");
    await writeFile(configPath, JSON.stringify({ agentsDir: join(base, "nope") }));
    await assert.rejects(loadSubagentConfig(configPath), /agentsDir.*nope/);
    await writeFile(configPath, JSON.stringify({ skillsDir: join(base, "nope") }));
    await assert.rejects(loadSubagentConfig(configPath), /skillsDir/);
    await writeFile(configPath, JSON.stringify({ piAgentDir: join(base, "nope") }));
    await assert.rejects(loadSubagentConfig(configPath), /piAgentDir/);
    await writeFile(
      configPath,
      JSON.stringify({ workerInstructionsFile: join(base, "missing.md"), ...dirs, agentsDir: dirs.agentsDir }),
    );
    await assert.rejects(loadSubagentConfig(configPath), /workerInstructionsFile/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("relative paths resolve against the config file dir and overrides win", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  try {
    const dirs = await makeDirs(base);
    const sub = join(base, "sub");
    await mkdir(sub, { recursive: true });
    const configPath = join(sub, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        agentsDir: "../agents",
        skillsDir: dirs.skillsDir,
        piAgentDir: dirs.piAgentDir,
        workerInstructionsFile: "../SUBAGENT_INSTRUCTIONS.md",
      }),
    );
    const config = await loadSubagentConfig(configPath, { port: 9999, maxConcurrent: 3 });
    assert.equal(config.agentsDir, dirs.agentsDir);
    assert.equal(config.port, 9999);
    assert.equal(config.maxConcurrent, 3);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("default config dir respects XDG_CONFIG_HOME", async () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(tmpdir(), "xdg-test-config");
  try {
    assert.ok(defaultConfigDir().startsWith(process.env.XDG_CONFIG_HOME));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
  assert.ok(defaultConfigDir().endsWith("pi-subagents-mcp"));
});
