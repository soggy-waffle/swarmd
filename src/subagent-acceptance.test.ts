import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadSubagentConfig } from "./subagent-config.js";
import { startSubagentMcpServer } from "./subagent-mcp.js";
import { createSubagentService } from "./subagent-service.js";

function writeModelResponse(response: ServerResponse, text: string) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (choices: unknown[], usage?: unknown) => response.write(`data: ${JSON.stringify({
    id: "local-test-completion", object: "chat.completion.chunk", created: 1,
    model: "local-test-model", choices, ...(usage ? { usage } : {}),
  })}\n\n`);
  chunk([{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }]);
  chunk([{ index: 0, delta: {}, finish_reason: "stop" }]);
  chunk([], { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 });
  response.end("data: [DONE]\n\n");
}

function parseToolPayload(result: unknown): unknown {
  const value = result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
  assert.notEqual(value.isError, true, JSON.stringify(result));
  if (value.structuredContent) return value.structuredContent;
  const text = value.content?.find((block) => block.type === "text")?.text;
  assert.ok(text, "MCP result has a JSON text payload");
  return JSON.parse(text);
}

test("real Pi SDK sessions run through HTTP MCP with global-only resources and retained history", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "swarmd-acceptance-"));
  const requests: Record<string, unknown>[] = [];
  const providerServer = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      requests.push(JSON.parse(body));
      writeModelResponse(response, `LOCAL_RESULT_${requests.length}`);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
  const address = providerServer.address();
  assert.ok(address && typeof address !== "string");
  let service: Awaited<ReturnType<typeof createSubagentService>> | undefined;
  let mcpServer: Awaited<ReturnType<typeof startSubagentMcpServer>> | undefined;
  const client = new Client({ name: "acceptance-test", version: "1.0.0" });
  try {
    const agentsDir = join(directory, "agents");
    const skillsDir = join(directory, "skills");
    const piAgentDir = join(directory, "pi-resources");
    const cwd = join(directory, "project");
    await Promise.all([agentsDir, skillsDir, piAgentDir, cwd].map((path) => mkdir(path, { recursive: true })));
    const shutdownSentinel = join(directory, "global-extension-shutdown");
    await mkdir(join(piAgentDir, "extensions"));
    await writeFile(join(piAgentDir, "extensions", "shutdown-check.ts"), `import { appendFileSync } from 'node:fs'; export default function(pi) { pi.on('session_shutdown', async () => { await new Promise(resolve => setTimeout(resolve, 20)); appendFileSync(${JSON.stringify(shutdownSentinel)}, 'shutdown\\n'); }); }\n`);
    await mkdir(join(skillsDir, "acceptance-skill"));
    await writeFile(join(skillsDir, "acceptance-skill", "SKILL.md"), "---\nname: acceptance-skill\ndescription: ACCEPTANCE_SKILL_MARKER test instructions\n---\n\nRead the task carefully.\n");
    await writeFile(join(agentsDir, "local.md"), "---\ndescription: Local no-cost verification worker\nmodel: acceptance-provider/local-test-model\nthinking: off\n---\n\nAGENT_BODY_MARKER\n");
    const workerInstructionsFile = join(directory, "SUBAGENT_INSTRUCTIONS.md");
    await writeFile(workerInstructionsFile, "COMMON_INSTRUCTIONS_MARKER\n");
    await writeFile(join(piAgentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
    await writeFile(join(piAgentDir, "models.json"), JSON.stringify({ providers: {
      "acceptance-provider": {
        baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "local-test-key",
        models: [{ id: "local-test-model", reasoning: false, input: ["text"], contextWindow: 16384, maxTokens: 1000 }],
      },
    } }));
    await writeFile(join(cwd, "AGENTS.md"), "PROJECT_AGENTS_MUST_NOT_LOAD\n");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    const sentinel = join(directory, "project-extension-executed");
    await writeFile(join(cwd, ".pi", "extensions", "unsafe-project.ts"), `import { writeFileSync } from 'node:fs'; export default function() { writeFileSync(${JSON.stringify(sentinel)}, 'bad'); }\n`);
    const configPath = join(directory, "config.json");
    await writeFile(configPath, JSON.stringify({ agentsDir, skillsDir, piAgentDir, workerInstructionsFile,
      transcripts: "disk", transcriptDir: join(directory, "transcripts"), excludeExtensions: ["mcp"], maxConcurrent: 2, port: 8787,
    }));
    const config = await loadSubagentConfig(configPath);
    service = await createSubagentService(config);
    mcpServer = await startSubagentMcpServer(service, 0);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpServer.port}/mcp`)));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    const agentsPayload = parseToolPayload(await client.callTool({ name: "list_agents", arguments: {} }));
    assert.match(JSON.stringify(agentsPayload), /acceptance-provider\/local-test-model/);
    const spawnPayload = parseToolPayload(await client.callTool({ name: "spawn_subagents", arguments: { tasks: [{ agent: "local", prompt: "FIRST_TASK_MARKER", cwd }] } }));
    assert.match(JSON.stringify(spawnPayload), /"success":true/);
    const worker = service.listSubagents()[0];
    assert.ok(worker);
    const waitPayload = parseToolPayload(await client.callTool({ name: "wait_subagents", arguments: { ids: [worker.id], type: "all", timeoutSeconds: 30 } }));
    assert.match(JSON.stringify(waitPayload), /LOCAL_RESULT_1/);
    assert.equal(service.listSubagents()[0].state, "idle");
    assert.equal(requests.length, 1);
    const initialRequest = JSON.stringify(requests[0]);
    assert.match(initialRequest, /COMMON_INSTRUCTIONS_MARKER/);
    assert.match(initialRequest, /AGENT_BODY_MARKER/);
    assert.match(initialRequest, /ACCEPTANCE_SKILL_MARKER/);
    assert.doesNotMatch(initialRequest, /PROJECT_AGENTS_MUST_NOT_LOAD/);
    assert.match(initialRequest, /codemode/);
    await assert.rejects(stat(sentinel), { code: "ENOENT" });
    await client.callTool({ name: "send_subagent", arguments: { id: worker.id, message: "SECOND_TASK_MARKER" } });
    const nextPayload = parseToolPayload(await client.callTool({ name: "wait_subagents", arguments: { ids: [worker.id], type: "all", timeoutSeconds: 30 } }));
    assert.match(JSON.stringify(nextPayload), /LOCAL_RESULT_2/);
    assert.match(JSON.stringify(requests[1]), /FIRST_TASK_MARKER/);
    assert.match(JSON.stringify(requests[1]), /SECOND_TASK_MARKER/);
    assert.equal(service.listSubagents()[0].generation, 2);
    const inspection = service.inspectSubagent(worker.id, 0, 1);
    assert.ok(inspection.events.length <= 1);
    assert.ok(inspection.nextCursor > 0);
    const remaining = service.inspectSubagent(worker.id, inspection.nextCursor, 1000);
    assert.ok(remaining.events.every((event) => event.cursor > inspection.nextCursor));
    const releasePayload = parseToolPayload(await client.callTool({ name: "release_subagents", arguments: { ids: [worker.id] } }));
    assert.match(JSON.stringify(releasePayload), /"success":true/);
    assert.equal(service.listSubagents().length, 0);
    assert.equal(await readFile(shutdownSentinel, "utf8"), "shutdown\n", "Release must await extension shutdown before returning");
    assert.ok(worker.transcriptPath, "disk mode must report a transcript path");
    const transcript = await readFile(worker.transcriptPath, "utf8");
    assert.match(transcript, /LOCAL_RESULT_1/);
    assert.match(transcript, /LOCAL_RESULT_2/);
    assert.equal((await stat(worker.transcriptPath)).mode & 0o077, 0);
  } finally {
    await client.close().catch(() => {});
    await service?.close();
    await mcpServer?.close();
    providerServer.closeAllConnections();
    await new Promise<void>((resolve) => providerServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
