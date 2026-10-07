#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { startSubagentMcpServer } from "../dist/subagent-mcp.js";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadSubagentConfig } from "../dist/subagent-config.js";
import { createSubagentService } from "../dist/subagent-service.js";

const root = await mkdtemp(join(tmpdir(), "pi-installed-plugins-"));
const targets = new Map();
let service;
let provider;
let mcp;
const measurements = [];
let phase = "boot";
let sampler;
function sample(label = phase) {
  const memory = process.memoryUsage();
  const smaps = readFileSync("/proc/self/smaps_rollup", "utf8");
  const kb = (key) => Number(smaps.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const row = { phase: label, rssMiB: kb("Rss") / 1024, pssMiB: kb("Pss") / 1024,
    heapMiB: memory.heapUsed / 1048576, externalMiB: memory.external / 1048576,
    arrayBuffersMiB: memory.arrayBuffers / 1048576, workers: service?.listSubagents().length ?? 0,
    running: service?.listSubagents().filter((w) => ["starting", "running"].includes(w.state)).length ?? 0 };
  measurements.push(row);
  return row;
}
async function settle(label, gc = false) {
  phase = label;
  if (gc) { assert.ok(global.gc, "Run node --expose-gc"); global.gc(); }
  await delay(600);
  console.log(JSON.stringify(sample(label)));
}

function respond(response, text, tool) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finishReason) => response.write(`data: ${JSON.stringify({
    id: "plugin-smoke", object: "chat.completion.chunk", created: 1, model: "smoke-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  if (tool) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: `call-${tool.name}-${Date.now()}`, type: "function", function: {
      name: tool.name, arguments: JSON.stringify(tool.arguments),
    } }] }, null);
    send({}, "tool_calls");
  } else {
    send({ role: "assistant", content: text }, null);
    send({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

try {
  const base = await loadSubagentConfig();
  const agentsDir = join(root, "agents");
  const transcriptDir = join(root, "transcripts");
  await Promise.all([agentsDir, transcriptDir].map((path) => mkdir(path)));
  for (const key of "ABCDEFGHIJ") {
    const cwd = join(root, key);
    await mkdir(cwd);
    const path = join(cwd, `${key.toLowerCase()}.marker`);
    await writeFile(path, "old\n");
    targets.set(key, { cwd, path });
  }
  provider = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      const userText = JSON.stringify(body.messages.filter((message) => message.role === "user"));
      const key = userText.match(/PLUGIN_SMOKE_([A-J])/)?.[1];
      await delay(200);
      const target = targets.get(key);
      const results = body.messages.filter((message) => message.role === "tool");
      const advertised = body.tools.map((tool) => tool.function.name);
      for (const name of ["fffind", "read", "edit", "tinyfish_search", "codemode"]) assert.ok(advertised.includes(name), `Missing installed tool ${name}`);
      if (results.length === 0) {
        respond(response, "", { name: "fffind", arguments: { pattern: ".marker" } });
      } else if (results.length === 1) {
        assert.match(JSON.stringify(results[0]), new RegExp(basename(target.path).replace(".", "\\.")), "FFF must search this worker's directory");
        const other = targets.get(key === "A" ? "B" : "A");
        assert.ok(!JSON.stringify(results[0]).includes(basename(other.path)), "FFF must not search another worker's directory");
        respond(response, "", { name: "read", arguments: { path: target.path } });
      } else if (results.length === 2) {
        const anchor = JSON.stringify(results[1]).match(/1#[A-Za-z0-9]+/)?.[0];
        assert.ok(anchor, "Hashline read must return a line anchor");
        respond(response, "", { name: "edit", arguments: { path: target.path, edits: [{ op: "replace", pos: anchor, lines: [`changed-${key}`] }] } });
      } else if (results.length === 3) {
        respond(response, "", { name: "codemode", arguments: { code: `const result = await tools.read({path: ${JSON.stringify(target.path)}}); text(result);` } });
      } else {
        assert.ok(JSON.stringify(results.at(-1)).includes(`changed-${key}`), "Codemode must call this worker's read tool");
        respond(response, "PLUGIN_SMOKE_OK\n" + "mock output ".repeat(5500));
      }
    } catch (error) {
      respond(response, `PLUGIN_SMOKE_FAILED: ${error.message}`);
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = provider.address().port;
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { "plugin-smoke": {
    baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "local-test-key",
    models: [{ id: "smoke-model", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768 }],
  } } }));
  await writeFile(join(agentsDir, "smoke.md"), "---\ndescription: Installed plugin verification\nmodel: plugin-smoke/smoke-model\nthinking: off\n---\n\nComplete the supplied task.\n");
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json") });
  service = await createSubagentService({ ...base, agentsDir, transcriptDir, maxConcurrent: 10 }, { modelRuntime: runtime });

  mcp = await startSubagentMcpServer(service, 0);
  await settle("idle");
  sampler = setInterval(() => sample(), 100);
  for (const [round, count] of [1, 10, 20, 10, 10].entries()) {
    const label = `${count}-round${round + 1}`;
    phase = `active-${label}`;
    const items = Array.from({length: count}, (_, index) => {
      const key = "ABCDEFGHIJ"[index % 10];
      return {agent: "smoke", prompt: `PLUGIN_SMOKE_${key}`, cwd: targets.get(key).cwd};
    });
    const outcomes = await service.spawnSubagents(items);
    assert.ok(outcomes.every((outcome) => outcome.success));
    const ids = outcomes.map((outcome) => outcome.worker.id);
    const result = await service.waitSubagents(ids, "all", 45);
    assert.equal(result.timedOut, false);
    assert.equal(result.finished.length, count);
    for (const worker of result.finished) {
      assert.equal(worker.state, "idle", worker.error);
      assert.ok(worker.result.startsWith("PLUGIN_SMOKE_OK"), worker.result.slice(0,300));
      assert.ok(worker.toolUses >= 4);
    }
    console.log(JSON.stringify({phase: `active-${label}-peak`,
      rssMiB: Math.max(...measurements.filter((row) => row.phase === phase).map((row) => row.rssMiB)),
      pssMiB: Math.max(...measurements.filter((row) => row.phase === phase).map((row) => row.pssMiB)),
      maxRunning: Math.max(...measurements.filter((row) => row.phase === phase).map((row) => row.running))}));
    await settle(`retained-${label}`);
    const released = await service.releaseSubagents(ids);
    assert.ok(released.every((outcome) => outcome.success));
    await settle(`released-${label}-natural`);
    await settle(`released-${label}-gc`, true);
  }
  clearInterval(sampler);
  sampler = undefined;
  await mcp.close();
  mcp = undefined;
  await service.close();
  service = undefined;
  await settle("closed-natural");
  await settle("closed-gc", true);
  const output = process.argv[2] ?? "/tmp/pi-subagents-memory.json";
  writeFileSync(output, JSON.stringify({pid: process.pid, workload: "Real Pi SDK and installed plugins; local mock provider; FFF/read/edit/codemode; approximately64KiB final output per worker; cap10. Same process also contains mock HTTP provider.", kernelPeakRssMiB: process.resourceUsage().maxRSS / 1024, samples: measurements}, null, 2));
  console.log(`Saved measurements: ${output}`);

} finally {
  if (sampler) clearInterval(sampler);
  await mcp?.close();
  await service?.close();
  if (provider) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}