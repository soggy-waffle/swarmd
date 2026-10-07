#!/usr/bin/env node
// Checks the compiled swarmd binary end to end: MCP handshake, installed Pi extensions,
// skills on disk, a real worker session, and a real tool call. Uses a local mock model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createProbe } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const binary = process.argv[2] ?? join(homedir(), ".config/swarmd/swarmd");
const piAgentDir = join(homedir(), ".config/pi");
const skillsDir = join(homedir(), ".agents/skills");
const skillPath = join(skillsDir, "ponytail/SKILL.md");
const root = await mkdtemp(join(tmpdir(), "swarmd-binary-"));
const requests = [];
let provider;
let service;
let client;

function freePort() {
  return new Promise((resolve) => {
    const probe = createProbe();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function respond(response, text, tool) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (delta, finishReason) => response.write(`data: ${JSON.stringify({
    id: "binary-smoke", object: "chat.completion.chunk", created: 1, model: "smoke-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  if (tool) {
    send({ role: "assistant", tool_calls: [{ index: 0, id: `call-${tool.name}-1`, type: "function", function: {
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
  provider = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    try {
      const body = JSON.parse(raw);
      requests.push(body);
      const results = body.messages.filter((message) => message.role === "tool");
      const advertised = body.tools.map((tool) => tool.function.name);
      for (const name of ["read", "fffind", "tinyfish_search", "codemode"]) {
        assert.ok(advertised.includes(name), `compiled binary must advertise installed tool ${name}`);
      }
      if (results.length === 0) {
        respond(response, "", { name: "read", arguments: { path: skillPath } });
      } else {
        assert.match(JSON.stringify(results[0]), /Ponytail/, "read tool must return the real skill file");
        respond(response, "BINARY_SMOKE_OK");
      }
    } catch (error) {
      respond(response, `BINARY_SMOKE_FAILED: ${error.message}`);
    }
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

  const agentsDir = join(root, "agents");
  const workerDir = join(root, "work");
  const runtimeDir = join(root, "pi");
  await Promise.all([agentsDir, workerDir, runtimeDir].map((path) => mkdir(path, { recursive: true })));
  await symlink(join(piAgentDir, "npm"), join(runtimeDir, "npm"));
  await writeFile(join(runtimeDir, "settings.json"), await readFile(join(piAgentDir, "settings.json"), "utf8"));
  await writeFile(join(runtimeDir, "auth.json"), "{}");
  await writeFile(join(runtimeDir, "models.json"), JSON.stringify({ providers: { "binary-smoke": {
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, api: "openai-completions", apiKey: "local-test-key",
    models: [{ id: "smoke-model", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 1000 }],
  } } }));
  await writeFile(join(agentsDir, "smoke.md"), "---\ndescription: Compiled binary check\nmodel: binary-smoke/smoke-model\nthinking: off\n---\n\nComplete the supplied task.\n");
  const configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ agentsDir, skillsDir,
    workerInstructionsFile: join(root, "instructions.md"), piAgentDir: runtimeDir,
    excludeExtensions: ["mcp"], transcripts: "memory", transcriptDir: join(root, "transcripts"),
    maxConcurrent: 2, port: 8787 }));
  await writeFile(join(root, "instructions.md"), "Read files before answering.\n");

  const port = await freePort();
  service = spawn(binary, ["--config", configPath, "--port", String(port), "--no-ui"], { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`binary did not start: ${log}`)), 20_000);
    const inspect = (chunk) => {
      log += chunk.toString();
      if (log.includes("MCP endpoint")) { clearTimeout(timer); resolve(); }
    };
    service.stdout.on("data", inspect);
    service.stderr.on("data", inspect);
    service.once("exit", (code) => { clearTimeout(timer); reject(new Error(`binary exited early with ${code}: ${log}`)); });
  });

  client = new Client({ name: "swarmd-binary-check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 10);
  const spawned = JSON.parse((await client.callTool({ name: "spawn_subagents", arguments: {
    tasks: [{ agent: "smoke", prompt: "Read the Ponytail skill file.", cwd: workerDir }],
  } })).content[0].text);
  const id = spawned.outcomes[0].worker.id;
  const waited = JSON.parse((await client.callTool({ name: "wait_subagents", arguments: { ids: [id], type: "all", timeoutSeconds: 60 } })).content[0].text);
  assert.equal(waited.timedOut, false);
  const worker = waited.finished[0];
  assert.equal(worker.state, "idle", worker.error);
  assert.equal(worker.result, "BINARY_SMOKE_OK");
  assert.ok(worker.toolUses >= 1, "worker must have used a tool");
  assert.equal(worker.transcriptPath, undefined, "memory mode must not report a transcript path");
  const inspection = JSON.parse((await client.callTool({ name: "inspect_subagent", arguments: { id, cursor: 0, limit: 500 } })).content[0].text);
  assert.match(JSON.stringify(inspection.events), /name: ponytail/, "transcript must show the real skill content");
  await client.callTool({ name: "release_subagents", arguments: { ids: [id], force: false } });
  assert.deepEqual(await readdir(join(root, "transcripts")).catch(() => []), [], "memory mode must write no transcript files");
  console.log(`Compiled binary smoke passed: 10 MCP tools, installed extensions advertised, real skill read, no disk transcripts. Binary: ${binary}`);
} finally {
  await client?.close().catch(() => {});
  if (service && service.exitCode === null) {
    const stopped = new Promise((resolve) => service.once("exit", resolve));
    service.kill("SIGTERM");
    await stopped;
  }
  if (provider) {
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
