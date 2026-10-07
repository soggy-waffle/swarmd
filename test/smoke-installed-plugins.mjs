#!/usr/bin/env node
import assert from "node:assert/strict";
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
  for (const key of ["A", "B"]) {
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
      const key = userText.includes("PLUGIN_SMOKE_A") ? "A" : "B";
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
        respond(response, "PLUGIN_SMOKE_OK");
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
    models: [{ id: "smoke-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1000 }],
  } } }));
  await writeFile(join(agentsDir, "smoke.md"), "---\ndescription: Installed plugin verification\nmodel: plugin-smoke/smoke-model\nthinking: off\n---\n\nComplete the supplied task.\n");
  const runtime = await ModelRuntime.create({ modelsPath, authPath: join(root, "auth.json") });
  service = await createSubagentService({ ...base, agentsDir, transcriptDir, maxConcurrent: 2 }, { modelRuntime: runtime });
  const outcomes = await service.spawnSubagents([...targets].map(([key, target]) => ({ agent: "smoke", prompt: `PLUGIN_SMOKE_${key}`, cwd: target.cwd })));
  assert.ok(outcomes.every((outcome) => outcome.success));
  const result = await service.waitSubagents(outcomes.map((outcome) => outcome.worker.id), "all", 30);
  assert.equal(result.timedOut, false);
  assert.equal(result.finished.length, 2);
  for (const worker of result.finished) {
    assert.equal(worker.state, "idle", worker.error);
    assert.equal(worker.result, "PLUGIN_SMOKE_OK");
    assert.equal(worker.toolUses, 4);
    const events = service.inspectSubagent(worker.id, 0, 1000).events;
    const errors = events.filter((event) => event.type === "extension_error");
    assert.deepEqual(errors, [], "Installed extensions must work without headless runtime errors");
  }
  for (const [key, target] of targets) assert.equal(await readFile(target.path, "utf8"), `changed-${key}\n`);
  console.log("Installed plugin smoke passed: concurrent FFF workspace isolation, hashline read/edit, codemode execution, and TinyFish availability. No paid model or search calls.");
} finally {
  await service?.close();
  if (provider) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
