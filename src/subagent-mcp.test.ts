import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type {
  SubagentDefinition,
  SubagentInspection,
  SubagentOperationOutcome,
  SubagentSnapshot,
  SubagentSpawnOutcome,
  SubagentSpawnTask,
  SubagentThinkingLevel,
  SubagentTranscriptEvent,
  SubagentWaitResult,
  SubagentWorkerService,
} from "./subagent-contracts.js";
import { startSubagentMcpServer, type SubagentMcpServerOptions } from "./subagent-mcp.js";

const TOOL_NAMES = [
  "list_agents",
  "spawn_subagents",
  "list_subagents",
  "inspect_subagent",
  "send_subagent",
  "configure_subagent",
  "stop_subagents",
  "wait_subagents",
  "get_subagent_results",
  "release_subagents",
];

function makeSnapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "w1",
    agent: "alpha",
    description: "worker",
    model: "m/x",
    thinking: "low",
    cwd: "/tmp",
    state: "idle",
    generation: 1,
    turns: 2,
    toolUses: 3,
    activity: "thinking",
    createdAt: new Date().toISOString(),
    usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0 },
    transcriptPath: "/tmp/w1.jsonl",
    result: "SECRET_RESULT",
    initialPrompt: "SECRET_PROMPT",
    ...overrides,
  };
}

class FakeService implements SubagentWorkerService {
  readonly agents: SubagentDefinition[] = [
    { name: "alpha", description: "Alpha worker", model: "m/x", defaultThinking: "low", supportedThinking: ["off", "low", "high"] },
  ];
  workers: SubagentSnapshot[] = [];
  waitMode: "immediate" | "pending" = "immediate";
  waitStarted = 0;
  waitSignals: Array<AbortSignal | undefined> = [];

  private waitWaiters: Array<() => void> = [];

  onWaitStarted(): Promise<void> {
    return new Promise((resolve) => this.waitWaiters.push(resolve));
  }

  async listAgents(): Promise<SubagentDefinition[]> {
    return this.agents;
  }

  async spawnSubagents(tasks: SubagentSpawnTask[]): Promise<SubagentSpawnOutcome[]> {
    return tasks.map((task, index) => {
      const worker = makeSnapshot({
        id: `w${this.workers.length + 1}`,
        agent: task.agent,
        cwd: task.cwd,
        thinking: task.thinking ?? "low",
        state: "running",
      });
      this.workers.push(worker);
      return { index, success: true, worker };
    });
  }

  listSubagents(): SubagentSnapshot[] {
    return this.workers;
  }

  inspectSubagent(id: string, cursor = 0, limit = 100): SubagentInspection {
    const worker = this.workers.find((entry) => entry.id === id) ?? makeSnapshot({ id });
    const events: SubagentTranscriptEvent[] = Array.from({ length: 5 }, (_, index) => ({
      cursor: index + 1,
      timestamp: new Date().toISOString(),
      type: "assistant",
      data: { text: `event ${index + 1}` },
    }));
    const page = events.filter((event) => event.cursor > cursor).slice(0, limit);
    const nextCursor = page.length ? page[page.length - 1].cursor : cursor;
    return { worker, events: page, nextCursor };
  }

  async sendSubagent(id: string, message: string): Promise<SubagentSnapshot> {
    const worker = this.workers.find((entry) => entry.id === id) ?? makeSnapshot({ id });
    worker.turns += 1;
    worker.result = `echo:${message}`;
    return worker;
  }

  async configureSubagent(id: string, thinking: SubagentThinkingLevel): Promise<SubagentSnapshot> {
    const worker = this.workers.find((entry) => entry.id === id) ?? makeSnapshot({ id });
    worker.thinking = thinking;
    return worker;
  }

  async stopSubagents(ids: string[]): Promise<SubagentOperationOutcome[]> {
    return ids.map((id) => {
      const worker = this.workers.find((entry) => entry.id === id);
      if (worker) worker.state = "stopped";
      return { id, success: !!worker, worker };
    });
  }

  waitSubagents(ids: string[], _type: "any" | "all", _timeoutSeconds?: number, signal?: AbortSignal): Promise<SubagentWaitResult> {
    this.waitStarted += 1;
    this.waitSignals.push(signal);
    this.waitWaiters.shift()?.();
    if (this.waitMode === "pending") {
      return new Promise((resolve) => {
        const settle = () =>
          resolve({
            finished: this.workers.filter((worker) => ids.includes(worker.id) && worker.state !== "running"),
            pending: this.workers.filter((worker) => ids.includes(worker.id) && worker.state === "running"),
            timedOut: false,
          });
        if (signal?.aborted) {
          settle();
          return;
        }
        signal?.addEventListener("abort", settle, { once: true });
      });
    }
    const selected = this.workers.filter((worker) => ids.includes(worker.id));
    return Promise.resolve({ finished: selected, pending: [], timedOut: false });
  }

  getSubagentResults(ids: string[]): SubagentOperationOutcome[] {
    return ids.map((id) => {
      const worker = this.workers.find((entry) => entry.id === id);
      return { id, success: !!worker, worker };
    });
  }

  async releaseSubagents(ids: string[], _force?: boolean): Promise<SubagentOperationOutcome[]> {
    return ids.map((id) => {
      const index = this.workers.findIndex((entry) => entry.id === id);
      const worker = index >= 0 ? this.workers[index] : undefined;
      if (index >= 0) this.workers.splice(index, 1);
      return { id, success: !!worker, worker };
    });
  }

  subscribe(): () => void {
    return () => {};
  }

  async close(): Promise<void> {}
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

async function withServer(
  service: FakeService,
  options: SubagentMcpServerOptions,
  run: (port: number) => Promise<void>,
): Promise<void> {
  const server = await startSubagentMcpServer(service, 0, options);
  try {
    await run(server.port);
  } finally {
    await server.close();
  }
}

async function connect(port: number): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  return client;
}

function payload(result: unknown): unknown {
  const value = result as { isError?: boolean; content?: { type: string; text?: string }[] };
  assert.notEqual(value.isError, true, JSON.stringify(result));
  const text = value.content?.find((block) => block.type === "text")?.text;
  assert.ok(text, "JSON text payload");
  return JSON.parse(text);
}

function rawRequest(
  port: number,
  options: { method: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method: options.method, path: "/mcp", headers: options.headers },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk.toString()));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      },
    );
    request.on("error", reject);
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
});

test("exposes exactly the ten tools with the expected schemas", async () => {
  const service = new FakeService();
  await withServer(service, {}, async (port) => {
    const client = await connect(port);
    try {
      const tools = await client.listTools();
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        [...TOOL_NAMES].sort(),
      );
      const spawn = tools.tools.find((tool) => tool.name === "spawn_subagents");
      assert.ok(spawn?.inputSchema);
    } finally {
      await client.close().catch(() => {});
    }
  });
});

test("handshake, list, spawn, inspect preserve outcomes and share one service", async () => {
  const service = new FakeService();
  await withServer(service, {}, async (port) => {
    const first = await connect(port);
    const second = await connect(port);
    try {
      const agents = payload(await first.callTool({ name: "list_agents", arguments: {} })) as { agents: SubagentDefinition[] };
      assert.equal(agents.agents[0]?.name, "alpha");
      assert.deepEqual(agents.agents[0]?.supportedThinking, ["off", "low", "high"]);

      const spawned = payload(
        await first.callTool({
          name: "spawn_subagents",
          arguments: { tasks: [{ agent: "alpha", prompt: "hello", cwd: "/tmp" }] },
        }),
      ) as { outcomes: SubagentSpawnOutcome[] };
      assert.equal(spawned.outcomes[0]?.success, true);
      assert.ok(spawned.outcomes[0]?.worker?.id);

      const listed = payload(await second.callTool({ name: "list_subagents", arguments: {} })) as {
        workers: SubagentSnapshot[];
      };
      assert.equal(listed.workers.length, 1, "second session sees the shared worker pool");
      assert.equal("result" in listed.workers[0], false, "list omits result text");

      const inspected = payload(
        await first.callTool({ name: "inspect_subagent", arguments: { id: listed.workers[0].id, limit: 2 } }),
      ) as SubagentInspection;
      assert.equal(inspected.events.length, 2);
      assert.ok(inspected.nextCursor >= 2);

      const results = payload(await first.callTool({ name: "get_subagent_results", arguments: { ids: [listed.workers[0].id] } })) as {
        outcomes: SubagentOperationOutcome[];
      };
      assert.match(JSON.stringify(results), /SECRET_RESULT/);
    } finally {
      await first.close().catch(() => {});
      await second.close().catch(() => {});
    }
  });
});

test("invalid tool input returns isError without killing the session", async () => {
  const service = new FakeService();
  await withServer(service, {}, async (port) => {
    const client = await connect(port);
    try {
      const empty = await client.callTool({ name: "spawn_subagents", arguments: { tasks: [] } });
      assert.equal((empty as { isError?: boolean }).isError, true);

      const relative = await client.callTool({
        name: "spawn_subagents",
        arguments: { tasks: [{ agent: "alpha", prompt: "x", cwd: "relative/path" }] },
      });
      assert.equal((relative as { isError?: boolean }).isError, true);

      const stillAlive = payload(await client.callTool({ name: "list_agents", arguments: {} })) as { agents: unknown[] };
      assert.equal(stillAlive.agents.length, 1);
    } finally {
      await client.close().catch(() => {});
    }
  });
});

test("rejects DNS-rebinding Host and cross-origin requests before allocating sessions", async () => {
  const service = new FakeService();
  await withServer(service, {}, async (port) => {
    const badHost = await rawRequest(port, {
      method: "POST",
      headers: { host: "evil.example", "content-type": "application/json" },
      body: INITIALIZE,
    });
    assert.equal(badHost.status, 403);

    const badOrigin = await rawRequest(port, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: INITIALIZE,
    });
    assert.equal(badOrigin.status, 403);
  });
});

test("returns 413 for oversized bodies and 404 for unknown sessions", async () => {
  const service = new FakeService();
  await withServer(service, { maxBodyBytes: 512 }, async (port) => {
    const huge = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "x".repeat(4096) } });
    const oversized = await rawRequest(port, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(huge)) },
      body: huge,
    });
    assert.equal(oversized.status, 413);

    const unknown = await rawRequest(port, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-session-id": "missing" },
      body: INITIALIZE,
    });
    assert.equal(unknown.status, 404);

    const missing = await rawRequest(port, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(missing.status, 400);
  });
});

test("hard-caps sessions while a wait is in flight instead of expiring it", async () => {
  const service = new FakeService();
  service.waitMode = "pending";
  service.workers.push(makeSnapshot({ id: "w1", state: "running" }));
  await withServer(service, { maxSessions: 1, sessionTtlMs: 10 }, async (port) => {
    const active = await connect(port);
    try {
      const pending = active.callTool({ name: "wait_subagents", arguments: { ids: ["w1"], type: "all", timeoutSeconds: 3600 } });
      pending.catch(() => {});
      await service.onWaitStarted();

      await assert.rejects(connect(port));

      const alive = payload(await active.callTool({ name: "list_agents", arguments: {} })) as { agents: unknown[] };
      assert.equal(alive.agents.length, 1, "active session survives the sweep while its wait is pending");
    } finally {
      await active.close().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});

test("closing the server aborts outstanding waits quickly without stopping workers", async () => {
  const service = new FakeService();
  service.waitMode = "pending";
  service.workers.push(makeSnapshot({ id: "w1", state: "running" }));
  const server = await startSubagentMcpServer(service, 0, {});
  const client = await connect(server.port);
  const pending = client.callTool({ name: "wait_subagents", arguments: { ids: ["w1"], type: "all", timeoutSeconds: 3600 } });
  pending.catch(() => {});
  await service.onWaitStarted();

  const started = Date.now();
  await server.close();
  assert.ok(Date.now() - started < 3000, "close drains instead of hanging on the wait");
  assert.equal(service.workers.length, 1, "workers survive client disconnects");

  await client.close().catch(() => {});
});

test("MCP cancellation aborts a pending wait without stopping workers or the session", async () => {
  const service = new FakeService();
  service.waitMode = "pending";
  service.workers.push(makeSnapshot({ id: "w1", state: "running" }));
  await withServer(service, {}, async (port) => {
    const client = await connect(port);
    try {
      const controller = new AbortController();
      const pending = client.callTool(
        { name: "wait_subagents", arguments: { ids: ["w1"], type: "all", timeoutSeconds: 3600 } },
        undefined,
        { signal: controller.signal },
      );
      await service.onWaitStarted();
      controller.abort();
      await assert.rejects(pending);
      await waitFor(() => service.waitSignals.at(-1)?.aborted === true);
      assert.equal(service.workers.length, 1, "cancelling a wait does not stop workers");
      const alive = payload(await client.callTool({ name: "list_agents", arguments: {} })) as { agents: unknown[] };
      assert.equal(alive.agents.length, 1, "session remains usable after a cancelled wait");
    } finally {
      await client.close().catch(() => {});
    }
  });
});

test("sends progress heartbeats while a wait is pending and clears its timer after settle", async () => {
  const service = new FakeService();
  service.waitMode = "pending";
  service.workers.push(makeSnapshot({ id: "w1", state: "running" }));

  const created: unknown[] = [];
  const cleared: unknown[] = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    const handle = (originalSetInterval as (...args: unknown[]) => unknown)(handler, ms, ...rest);
    if (ms === 20) created.push(handle);
    return handle;
  }) as typeof setInterval;
  globalThis.clearInterval = ((handle?: unknown) => {
    cleared.push(handle);
    return (originalClearInterval as (value?: unknown) => void)(handle);
  }) as typeof clearInterval;
  try {
    await withServer(service, { waitProgressIntervalMs: 20 }, async (port) => {
      const client = await connect(port);
      try {
        const progress: number[] = [];
        const controller = new AbortController();
        const pending = client.callTool(
          { name: "wait_subagents", arguments: { ids: ["w1"], type: "all", timeoutSeconds: 3600 } },
          undefined,
          { signal: controller.signal, onprogress: (event) => progress.push(event.progress) },
        );
        pending.catch(() => {});
        await service.onWaitStarted();
        await waitFor(() => progress.length >= 2);
        controller.abort();
        await assert.rejects(pending);
        await waitFor(() => created.length > 0 && created.every((handle) => cleared.includes(handle)));
      } finally {
        await client.close().catch(() => {});
      }
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
