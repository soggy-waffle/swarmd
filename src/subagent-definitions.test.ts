import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clampThinkingFor,
  loadAgentDefinitions,
  parseAgentFile,
  resolveAgentDefinition,
  supportedThinkingFor,
} from "./subagent-definitions.js";

const VALID = `---
description: Test worker
model: test-provider/thinker
thinking: high
---

Body instructions here.
`;

test("parseAgentFile reads name/description/model/thinking/body", () => {
  const parsed = parseAgentFile("alpha", VALID, "/agents/alpha.md");
  assert.equal(parsed.name, "alpha");
  assert.equal(parsed.description, "Test worker");
  assert.equal(parsed.model, "test-provider/thinker");
  assert.equal(parsed.provider, "test-provider");
  assert.equal(parsed.modelId, "thinker");
  assert.equal(parsed.defaultThinking, "high");
  assert.equal(parsed.body, "Body instructions here.");
});

test("parseAgentFile accepts legacy prompt_mode:replace and max_turns:0, rejects conflicts", () => {
  const legacy = `---
description: Legacy
model: p/m
prompt_mode: replace
max_turns: 0
---

Body.
`;
  assert.doesNotThrow(() => parseAgentFile("legacy", legacy, "/agents/legacy.md"));
  assert.throws(
    () => parseAgentFile("bad", legacy.replace("replace", "append"), "/agents/bad.md"),
    /prompt_mode/,
  );
  assert.throws(
    () => parseAgentFile("bad", legacy.replace("max_turns: 0", "max_turns: 5"), "/agents/bad.md"),
    /max_turns/,
  );
});

test("parseAgentFile rejects unknown fields, bad model, bad thinking, empty body", () => {
  const base = `---\ndescription: D\nmodel: p/m\n---\n\nBody.\n`;
  assert.throws(() => parseAgentFile("x", base.replace("model: p/m", "model: p/m\nextra: 1"), "/a.md"), /unknown/);
  assert.throws(() => parseAgentFile("x", base.replace("model: p/m", "model: nomodel"), "/a.md"), /provider\/id/);
  assert.throws(() => parseAgentFile("x", base.replace("model: p/m", "model: p/ "), "/a.md"), /provider\/id/);
  assert.throws(() => parseAgentFile("x", base.replace("model: p/m", "model: p/m\nthinking: ultra"), "/a.md"), /thinking/);
  assert.throws(() => parseAgentFile("x", "---\ndescription: D\n---\n\nBody.\n", "/a.md"), /"model" is required/);
  assert.throws(() => parseAgentFile("x", "---\nmodel: p/m\n---\n\nBody.\n", "/a.md"), /"description" is required/);
  assert.throws(() => parseAgentFile("x", "---\ndescription: D\nmodel: p/m\n---\n", "/a.md"), /body must contain/);
});

test("loadAgentDefinitions reads a directory and resolveAgentDefinition pins models", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-defs-"));
  try {
    await writeFile(join(base, "b.md"), VALID);
    await writeFile(join(base, "a.md"), VALID.replace("alpha", "a").replace("test-provider/thinker", "p/m"));
    await writeFile(join(base, "notes.txt"), "ignored");
    const withoutRuntime = await loadAgentDefinitions(base);
    assert.deepEqual(withoutRuntime.map((entry) => entry.name), ["a", "b"]);
    const runtime = {
      getModel: (provider: string, id: string) =>
        provider === "test-provider" && id === "thinker"
          ? ({ provider, id, reasoning: true } as never)
          : undefined,
    } as never;
    const byName = new Map(withoutRuntime.map((entry) => [entry.name, entry]));
    const resolvedB = resolveAgentDefinition(runtime, byName.get("b")!);
    assert.equal(resolvedB.definition.supportedThinking.length > 0, true);
    assert.throws(() => resolveAgentDefinition(runtime, byName.get("a")!), /Unknown model "p\/m"/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("thinking helpers reflect real model metadata", () => {
  const plain = { provider: "p", id: "plain", reasoning: false } as never;
  assert.deepEqual(supportedThinkingFor(plain), ["off"]);
  assert.equal(clampThinkingFor(plain, "high"), "off");
  const flashlike = {
    provider: "p",
    id: "f",
    reasoning: true,
    thinkingLevelMap: { off: "o", low: "l", high: "h", max: "m", minimal: null, medium: null, xhigh: null },
  } as never;
  assert.deepEqual(supportedThinkingFor(flashlike), ["off", "low", "high", "max"]);
  assert.equal(clampThinkingFor(flashlike, "medium"), "high");
});

test("loadAgentDefinitions surfaces unreadable directories", async () => {
  await assert.rejects(loadAgentDefinitions(join(tmpdir(), "pi-subagents-missing-dir")), /Cannot read agents directory/);
  const base = await mkdtemp(join(tmpdir(), "pi-subagents-defs-"));
  try {
    await mkdir(join(base, "sub"), { recursive: true });
    const empty = await loadAgentDefinitions(base);
    assert.deepEqual(empty, []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
