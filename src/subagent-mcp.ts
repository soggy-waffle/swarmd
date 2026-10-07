import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isAbsolute } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { z } from "zod";

import type {
  SubagentOperationOutcome,
  SubagentSnapshot,
  SubagentSpawnOutcome,
  SubagentSpawnTask,
  SubagentThinkingLevel,
  SubagentWorkerService,
} from "./subagent-contracts.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const thinkingSchema = z.enum(THINKING_LEVELS);

const LOCAL_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const WAIT_PROGRESS_INTERVAL_MS = 15 * 1000;
const CLOSE_TIMEOUT_MS = 3000;

const MAX_SPAWN_TASKS = 32;
const MAX_IDS = 64;
const MAX_PROMPT_CHARS = 200_000;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_TRANSCRIPT_LIMIT = 500;

const taskSchema = z.object({
  agent: z.string().min(1),
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS),
  cwd: z.string().min(1).refine(isAbsolute, "cwd must be an absolute path"),
  description: z.string().max(10_000).optional(),
  thinking: thinkingSchema.optional(),
});

const idsSchema = z.array(z.string().min(1)).min(1).max(MAX_IDS);

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function requestIdOf(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return (body as { id?: unknown }).id ?? null;
  }
  return null;
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, error: { code, message }, id: id ?? null };
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return !!body && typeof body === "object" && (body as { method?: unknown }).method === "initialize";
}

function stripResult(snapshot: SubagentSnapshot): Omit<SubagentSnapshot, "result" | "initialPrompt"> {
  const { result: _result, initialPrompt: _initialPrompt, ...rest } = snapshot;
  return rest;
}

function stripOutcome(outcome: SubagentOperationOutcome): Omit<SubagentOperationOutcome, "worker"> & {
  worker?: Omit<SubagentSnapshot, "result" | "initialPrompt">;
} {
  return outcome.worker ? { ...outcome, worker: stripResult(outcome.worker) } : outcome;
}

function stripSpawnOutcome(outcome: SubagentSpawnOutcome): Omit<SubagentSpawnOutcome, "worker"> & {
  worker?: Omit<SubagentSnapshot, "result" | "initialPrompt">;
} {
  return outcome.worker ? { ...outcome, worker: stripResult(outcome.worker) } : outcome;
}

function linkedSignal(primary: AbortSignal, secondary?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  if (!secondary) return { signal: primary, dispose: () => {} };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (primary.aborted || secondary.aborted) controller.abort();
  primary.addEventListener("abort", onAbort);
  secondary.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", onAbort);
      secondary.removeEventListener("abort", onAbort);
    },
  };
}

class BodyTooLargeError extends Error {}
class SessionCapacityError extends Error {}

function readRequestJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        req.resume();
        finish(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        finish(undefined, undefined);
        return;
      }
      try {
        finish(undefined, JSON.parse(raw));
      } catch {
        finish(new SyntaxError("Invalid JSON body"));
      }
    });
    req.on("error", (error) => finish(error));
    req.on("aborted", () => finish(new Error("Request aborted")));
  });
}

export interface SubagentMcpServerOptions {
  maxBodyBytes?: number;
  maxSessions?: number;
  sessionTtlMs?: number;
  waitProgressIntervalMs?: number;
  onError?: (error: Error) => void;
}

export interface SubagentMcpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface Session {
  id?: string;
  touched: number;
  active: number;
  abort: AbortController;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface CreateSubagentMcpServerOptions {
  signal?: AbortSignal;
  waitProgressIntervalMs?: number;
}

export function createSubagentMcpServer(service: SubagentWorkerService, options: CreateSubagentMcpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "pi-subagents", version: "0.1.0" });

  server.registerTool(
    "list_agents",
    {
      title: "List agents",
      description: "List configured worker agent definitions, models, and supported thinking levels.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok({ agents: await service.listAgents() });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "spawn_subagents",
    {
      title: "Spawn subagents",
      description: "Queue one or more worker tasks and return worker IDs immediately without waiting for completion.",
      inputSchema: { tasks: z.array(taskSchema).min(1).max(MAX_SPAWN_TASKS) },
    },
    async ({ tasks }) => {
      try {
        const outcomes = await service.spawnSubagents(tasks as SubagentSpawnTask[]);
        return ok({ outcomes: outcomes.map(stripSpawnOutcome) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "list_subagents",
    {
      title: "List subagents",
      description: "List current workers with state, activity, turns, usage, and context estimates. Results are omitted.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok({ workers: service.listSubagents().map(stripResult) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "inspect_subagent",
    {
      title: "Inspect subagent",
      description: "Read one worker and a page of transcript events. Full transcript text is only returned here.",
      inputSchema: {
        id: z.string().min(1),
        cursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(MAX_TRANSCRIPT_LIMIT).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, cursor, limit }) => {
      try {
        return ok(service.inspectSubagent(id, cursor, limit));
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "send_subagent",
    {
      title: "Send to subagent",
      description: "Steer an active worker or submit another task to a worker.",
      inputSchema: { id: z.string().min(1), message: z.string().min(1).max(MAX_MESSAGE_CHARS) },
    },
    async ({ id, message }) => {
      try {
        return ok({ worker: stripResult(await service.sendSubagent(id, message)) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "configure_subagent",
    {
      title: "Configure subagent",
      description: "Set the thinking level used for a worker's subsequent requests.",
      inputSchema: { id: z.string().min(1), thinking: thinkingSchema },
    },
    async ({ id, thinking }) => {
      try {
        return ok({ worker: stripResult(await service.configureSubagent(id, thinking as SubagentThinkingLevel)) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "stop_subagents",
    {
      title: "Stop subagents",
      description: "Cancel selected workers' current work while retaining the workers.",
      inputSchema: { ids: idsSchema },
    },
    async ({ ids }) => {
      try {
        return ok({ outcomes: (await service.stopSubagents(ids)).map(stripOutcome) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "wait_subagents",
    {
      title: "Wait for subagents",
      description:
        "Wait for any or all selected workers to finish. Cancelling or timing out a wait does not stop workers.",
      inputSchema: {
        ids: idsSchema,
        type: z.enum(["any", "all"]),
        timeoutSeconds: z.number().int().min(1).max(3600).optional(),
      },
    },
    async ({ ids, type, timeoutSeconds }, extra) => {
      const progressToken = extra._meta?.progressToken;
      let keepalive: NodeJS.Timeout | undefined;
      if (progressToken !== undefined) {
        const token = progressToken;
        let progress = 0;
        keepalive = setInterval(() => {
          progress += 1;
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: { progressToken: token, progress, message: "waiting for subagents" },
            })
            .catch(() => {});
        }, options.waitProgressIntervalMs ?? WAIT_PROGRESS_INTERVAL_MS);
        keepalive.unref();
      }
      const linked = linkedSignal(options.signal ?? new AbortController().signal, extra.signal);
      try {
        if (linked.signal.aborted) return ok({ canceled: true });
        const result = await service.waitSubagents(ids, type, timeoutSeconds, linked.signal);
        return ok(result);
      } catch (error) {
        if (linked.signal.aborted || isAbortError(error)) return ok({ canceled: true });
        return fail(errorMessage(error));
      } finally {
        if (keepalive) clearInterval(keepalive);
        linked.dispose();
      }
    },
  );

  server.registerTool(
    "get_subagent_results",
    {
      title: "Get subagent results",
      description: "Fetch currently available results for selected workers without waiting.",
      inputSchema: { ids: idsSchema },
      annotations: { readOnlyHint: true },
    },
    async ({ ids }) => {
      try {
        return ok({ outcomes: service.getSubagentResults(ids) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "release_subagents",
    {
      title: "Release subagents",
      description: "Dispose selected workers and free their session resources.",
      inputSchema: { ids: idsSchema, force: z.boolean().optional() },
    },
    async ({ ids, force }) => {
      try {
        return ok({ outcomes: (await service.releaseSubagents(ids, force)).map(stripOutcome) });
      } catch (error) {
        return fail(errorMessage(error));
      }
    },
  );

  return server;
}

export async function startSubagentMcpServer(
  service: SubagentWorkerService,
  port: number,
  options: SubagentMcpServerOptions = {},
): Promise<SubagentMcpServerHandle> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const onError = options.onError ?? (() => {});
  const report = (error: unknown) => onError(error instanceof Error ? error : new Error(String(error)));

  const sessions = new Map<string, Session>();
  const allSessions = new Set<Session>();
  let allowedHosts: string[] = [];
  let allowedOrigins: string[] = [];
  let closed = false;

  const closeSession = async (session: Session) => {
    allSessions.delete(session);
    if (session.id) sessions.delete(session.id);
    session.abort.abort();
    try {
      await session.transport.close();
    } catch (error) {
      report(error);
    }
  };

  const evictableSessions = () =>
    [...allSessions].filter((session) => session.active === 0).sort((a, b) => a.touched - b.touched);

  const sweep = () => {
    const now = Date.now();
    for (const session of [...allSessions]) {
      if (session.active === 0 && now - session.touched > sessionTtlMs) void closeSession(session);
    }
  };

  const createSession = async (): Promise<Session> => {
    if (allSessions.size >= maxSessions) {
      sweep();
      const evictable = evictableSessions();
      if (!evictable.length) throw new SessionCapacityError("Too many active sessions");
      await closeSession(evictable[0]);
      if (allSessions.size >= maxSessions) throw new SessionCapacityError("Too many active sessions");
    }

    if (closed) throw new SessionCapacityError("MCP server is closing");

    let session: Session | undefined;
    const abort = new AbortController();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (sessionId) => {
        if (!session) return;
        session.id = sessionId;
        session.touched = Date.now();
        sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    const server = createSubagentMcpServer(service, {
      signal: abort.signal,
      waitProgressIntervalMs: options.waitProgressIntervalMs,
    });
    session = { touched: Date.now(), active: 0, abort, transport, server };
    const current = session;
    allSessions.add(current);
    try {
      await server.connect(transport);
    } catch (error) {
      await closeSession(current);
      throw error;
    }
    if (closed) {
      await closeSession(current);
      throw new SessionCapacityError("MCP server is closing");
    }
    const protocolOnClose = transport.onclose;
    transport.onclose = () => {
      protocolOnClose?.();
      allSessions.delete(current);
      if (current.id) sessions.delete(current.id);
    };
    const protocolOnError = transport.onerror;
    transport.onerror = (error) => {
      protocolOnError?.(error);
      report(error);
    };
    return current;
  };

  const sendJson = (res: ServerResponse, status: number, payload: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const hostAllowed = (host?: string) => !!host && allowedHosts.includes(host);
  const originAllowed = (origin?: string) => !origin || allowedOrigins.includes(origin);

  const routeToSession = async (session: Session, req: IncomingMessage, res: ServerResponse, body: unknown) => {
    session.touched = Date.now();
    session.active += 1;
    try {
      await session.transport.handleRequest(req, res, body);
    } finally {
      session.active -= 1;
    }
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? LOCAL_HOST}`);
      if (requestUrl.pathname !== "/mcp") {
        sendJson(res, 404, jsonRpcError(null, -32601, "Not found"));
        return;
      }

      const method = req.method ?? "GET";
      if (method !== "POST" && method !== "GET" && method !== "DELETE") {
        res.setHeader("allow", "GET, POST, DELETE");
        sendJson(res, 405, jsonRpcError(null, -32600, "Method not allowed"));
        return;
      }

      if (!hostAllowed(req.headers.host)) {
        sendJson(res, 403, jsonRpcError(null, -32000, `Invalid Host header: ${req.headers.host ?? ""}`));
        return;
      }
      if (!originAllowed(req.headers.origin)) {
        sendJson(res, 403, jsonRpcError(null, -32000, `Invalid Origin header: ${req.headers.origin ?? ""}`));
        return;
      }

      sweep();

      const rawSessionId = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

      let body: unknown;
      if (method === "POST") {
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          sendJson(res, 415, jsonRpcError(null, -32600, "Content-Type must be application/json"));
          return;
        }
        try {
          body = await readRequestJson(req, maxBodyBytes);
        } catch (error) {
          if (error instanceof BodyTooLargeError) {
            sendJson(res, 413, jsonRpcError(null, -32600, "Request body too large"));
            return;
          }
          sendJson(res, 400, jsonRpcError(requestIdOf(body), -32700, "Parse error"));
          return;
        }
      }

      if (closed) {
        sendJson(res, 503, jsonRpcError(requestIdOf(body), -32000, "MCP server is closing"));
        return;
      }

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, jsonRpcError(requestIdOf(body), -32001, "Session not found"));
          return;
        }
        await routeToSession(session, req, res, body);
        return;
      }

      if (method === "POST" && isInitializeRequest(body)) {
        let session: Session;
        try {
          session = await createSession();
        } catch (error) {
          if (error instanceof SessionCapacityError) {
            sendJson(res, 503, jsonRpcError(requestIdOf(body), -32000, "Too many active sessions"));
            return;
          }
          throw error;
        }
        await routeToSession(session, req, res, body);
        return;
      }

      sendJson(res, 400, jsonRpcError(requestIdOf(body), -32000, "Missing or invalid session id"));
    } catch (error) {
      report(error);
      if (res.headersSent) res.end();
      else sendJson(res, 500, jsonRpcError(null, -32603, "Internal error"));
    }
  };

  const httpServer = createServer((req, res) => {
    void handler(req, res);
  });
  httpServer.on("clientError", (error, socket) => {
    report(error);
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      httpServer.off("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(port, LOCAL_HOST);
  });

  const address = httpServer.address() as AddressInfo | null;
  const actualPort = address && typeof address === "object" ? address.port : port;
  allowedHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
  allowedOrigins = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`];

  const sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(sweepTimer);
    const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.all([...allSessions].map((session) => closeSession(session)));
    sessions.clear();
    httpServer.closeAllConnections();
    let closeTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        httpClosed,
        new Promise<void>((resolve) => {
          closeTimer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          closeTimer.unref();
        }),
      ]);
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
    }
  };

  return { port: actualPort, url: `http://${LOCAL_HOST}:${actualPort}/mcp`, close };
}
