import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { loadSubagentConfig } from "./subagent-config.js";
import type { SubagentWorkerService } from "./subagent-contracts.js";
import { startSubagentMcpServer, type SubagentMcpServerHandle } from "./subagent-mcp.js";
import { createSubagentService } from "./subagent-service.js";
import { SubagentTerminal } from "./subagent-terminal.js";

const HELP = `Usage: pi-subagents-mcp [options]

Starts a local Streamable HTTP MCP server that owns a shared pool of Pi worker sessions.

Options:
  -h, --help                Show this help and exit
      --config <path>       Global config file (default: ~/.config/pi-subagents-mcp/config.json)
      --port <number>       Override the listening port (default from config, usually 8787)
      --max-concurrent <n>  Override the maximum number of concurrently running workers
      --no-ui               Do not draw the live terminal view; log lifecycle updates to stderr
`;

export interface CliOptions {
  help: boolean;
  configPath?: string;
  port?: number;
  maxConcurrent?: number;
  noUi: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      config: { type: "string" },
      port: { type: "string" },
      "max-concurrent": { type: "string" },
      "no-ui": { type: "boolean" },
    },
    allowPositionals: false,
    strict: true,
  });

  let port: number | undefined;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`--port must be an integer between 1 and 65535 (received "${values.port}")`);
    }
  }

  let maxConcurrent: number | undefined;
  if (values["max-concurrent"] !== undefined) {
    maxConcurrent = Number(values["max-concurrent"]);
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`--max-concurrent must be an integer of at least 1 (received "${values["max-concurrent"]}")`);
    }
  }

  return {
    help: values.help ?? false,
    configPath: values.config,
    port,
    maxConcurrent,
    noUi: values["no-ui"] ?? false,
  };
}

function logErr(message: string): void {
  try {
    process.stderr.write(`${message}\n`);
  } catch {
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Cleanup timed out after ${ms} ms`));
    }, ms);
    timer.unref();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    logErr(`pi-subagents-mcp: ${errorText(error)}`);
    logErr("Run pi-subagents-mcp --help for usage.");
    return 1;
  }

  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let service: SubagentWorkerService | undefined;
  let server: SubagentMcpServerHandle | undefined;
  let terminal: SubagentTerminal | undefined;
  let shuttingDown = false;

  const cleanup = async () => {
    terminal?.stop();
    terminal = undefined;
    const activeServer = server;
    server = undefined;
    const activeService = service;
    service = undefined;
    if (activeServer) {
      try {
        await withTimeout(activeServer.close(), 4000);
      } catch (error) {
        logErr(`pi-subagents-mcp: error closing MCP server: ${errorText(error)}`);
      }
    }
    if (activeService) {
      try {
        await withTimeout(activeService.close(), 5000);
      } catch (error) {
        logErr(`pi-subagents-mcp: error closing worker service: ${errorText(error)}`);
      }
    }
  };

  const shutdown = async (code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await cleanup();
    process.exitCode = code;
    const force = setTimeout(() => process.exit(code), 200);
    force.unref();
  };

  const onSignal = (signal: NodeJS.Signals) => {
    logErr(`pi-subagents-mcp: received ${signal}, shutting down`);
    void shutdown(0);
  };
  const onStdoutError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") void shutdown(0);
  };
  const onStderrError = () => {};

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.stdout.on("error", onStdoutError);
  process.stderr.on("error", onStderrError);

  const removeProcessListeners = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.stdout.off("error", onStdoutError);
    process.stderr.off("error", onStderrError);
  };

  try {
    const config = await loadSubagentConfig(options.configPath, {
      port: options.port,
      maxConcurrent: options.maxConcurrent,
    });
    if (shuttingDown) return 0;
    const created = await createSubagentService(config);
    service = created;
    if (shuttingDown) {
      await cleanup();
      return 0;
    }
    server = await startSubagentMcpServer(created, config.port, {
      onError: (error) => logErr(`pi-subagents-mcp: ${error.message}`),
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      logErr(`pi-subagents-mcp: port ${options.port ?? "configured"} is already in use. Stop the other process or pass --port.`);
    } else if (code === "EACCES") {
      logErr("pi-subagents-mcp: permission denied while binding the port. Choose an unprivileged port with --port.");
    } else {
      logErr(`pi-subagents-mcp: failed to start: ${errorText(error)}`);
    }
    await cleanup();
    removeProcessListeners();
    process.exitCode = 1;
    return 1;
  }

  if (shuttingDown) {
    await cleanup();
    return 0;
  }

  terminal = new SubagentTerminal({
    service: service as SubagentWorkerService,
    title: "pi-subagents",
    enabled: !options.noUi && Boolean(process.stdout.isTTY && process.stdin.isTTY),
    onQuit: () => {
      void shutdown(0);
    },
  });

  logErr(`pi-subagents-mcp: MCP endpoint ${(server as SubagentMcpServerHandle).url}`);
  logErr("pi-subagents-mcp: press q in the view to stop; SIGINT/SIGTERM also shut down cleanly");

  try {
    terminal.start();
  } catch (error) {
    logErr(`pi-subagents-mcp: terminal view failed, continuing without UI: ${errorText(error)}`);
    terminal.stop();
    terminal = new SubagentTerminal({ service: service as SubagentWorkerService, enabled: false });
    terminal.start();
  }

  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exitCode = code;
    },
    (error) => {
      logErr(`pi-subagents-mcp: unexpected error: ${errorText(error)}`);
      process.exitCode = 1;
    },
  );
}
