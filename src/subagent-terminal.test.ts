import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import type { SubagentSnapshot, SubagentTranscriptEvent, SubagentWorkerService } from "./subagent-contracts.js";
import {
  SubagentTerminal,
  extractEventText,
  formatContext,
  formatDuration,
  formatEventLine,
  formatEventLines,
  formatTokens,
  formatWorkerRow,
  sanitize,
  workerSummary,
} from "./subagent-terminal.js";

function makeSnapshot(overrides: Partial<SubagentSnapshot> = {}): SubagentSnapshot {
  return {
    id: "w1",
    agent: "alpha",
    description: "worker",
    model: "m/x",
    thinking: "low",
    cwd: "/tmp",
    state: "running",
    generation: 1,
    turns: 3,
    toolUses: 4,
    activity: "editing file",
    createdAt: new Date(Date.now() - 5000).toISOString(),
    startedAt: new Date(Date.now() - 5000).toISOString(),
    usage: { input: 1200, output: 800, cacheRead: 3000, cacheWrite: 0 },
    contextPercent: 42,
    transcriptPath: "/tmp/w1.jsonl",
    initialPrompt: "Do the benchmark task and report findings.",
    ...overrides,
  };
}

class FakeOutput {
  columns = 120;
  rows = 24;
  isTTY = true;
  writable = true;
  chunks: string[] = [];
  write(text: string): boolean {
    this.chunks.push(text);
    return true;
  }
}

class FakeInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  setRawMode(value: boolean): this {
    this.rawModes.push(value);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

function fakeService(workers: SubagentSnapshot[]): SubagentWorkerService {
  return {
    listAgents: async () => [],
    spawnSubagents: async () => [],
    listSubagents: () => workers,
    inspectSubagent: (id: string) => ({
      worker: workers.find((worker) => worker.id === id) ?? makeSnapshot({ id }),
      events: [],
      nextCursor: 0,
    }),
    sendSubagent: async () => workers[0],
    configureSubagent: async () => workers[0],
    stopSubagents: async () => [],
    waitSubagents: async () => ({ finished: [], pending: [], timedOut: false }),
    getSubagentResults: () => [],
    releaseSubagents: async () => [],
    subscribe: () => () => {},
    close: async () => {},
  };
}

function startTerminal(service: SubagentWorkerService, onQuit: () => void) {
  const out = new FakeOutput();
  const input = new FakeInput();
  const terminal = new SubagentTerminal({
    service,
    out: out as unknown as NodeJS.WriteStream,
    input: input as unknown as NodeJS.ReadStream,
    enabled: true,
    onQuit,
  });
  terminal.start();
  return { out, input, terminal };
}

test("formats tokens, durations, and context without implying a lifetime sum", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(125_000), "2m05s");
  assert.equal(formatContext(makeSnapshot({ contextPercent: 42 })), "42%");
  assert.equal(formatContext(makeSnapshot({ contextPercent: undefined, contextTokens: 2048 })), "2.0k");
  assert.equal(formatContext(makeSnapshot({ contextPercent: undefined, contextTokens: undefined })), "-");
});

test("worker rows show activity and selected summary shows model and thinking", () => {
  const worker = makeSnapshot({ agent: "alpha", activity: "running tests", model: "gpt/x", thinking: "high" });
  const row = formatWorkerRow(worker, Date.now());
  assert.match(row, /alpha/);
  assert.match(row, /running tests/);
  const summary = workerSummary(worker, Date.now());
  assert.match(summary, /gpt\/x/);
  assert.match(summary, /high/);
  assert.match(summary, /ctx 42%/);
});

test("sanitizes terminal control and OSC sequences", () => {
  assert.equal(sanitize("a\x1b[31mred\x1b[0m"), "ared");
  assert.equal(sanitize("\x1b]0;clipboard\x07x"), "x");
  assert.equal(sanitize("ok\x00\x07"), "ok");
  const row = formatWorkerRow(makeSnapshot({ agent: "e\x1b[31mvil" }), Date.now());
  assert.equal(row.includes("\x1b"), false);
});

test("extracts readable text from common transcript event shapes", () => {
  assert.equal(extractEventText({ delta: { text: "hello" } }), "hello");
  assert.equal(extractEventText({ content: [{ type: "text", text: "hi there" }] }), "hi there");
  assert.equal(extractEventText({ message: { content: [{ type: "text", text: "nested" }] } }), "nested");
  assert.match(extractEventText({ type: "tool_use", name: "read", input: { path: "/x" } }), /read\(\{"path":"\/x"\}\)/);
  assert.match(formatEventLine({ cursor: 7, type: "assistant", timestamp: "", data: { delta: { text: "streamed" } } }), /#7 assistant streamed/);
});

test("renders multiline transcript output instead of one truncated line", () => {
  const event: SubagentTranscriptEvent = {
    cursor: 3,
    timestamp: "",
    type: "tool_result",
    data: { text: `first line\n${"word ".repeat(30)}` },
  };
  const lines = formatEventLines(event, 40);
  assert.ok(lines.length > 2);
  assert.equal(lines[0], "#3 tool_result");
  assert.equal(lines[1].startsWith("  "), true);
});

test("detail view pins the initial task prompt above streamed output", () => {
  const service = fakeService([makeSnapshot({ initialPrompt: "PINNED_TASK_INSTRUCTION with more detail" })]);
  const { input, terminal } = startTerminal(service, () => {});
  try {
    input.emit("data", "\r");
    const lines = terminal.buildLines(120, 24);
    assert.match(lines[1], /PINNED_TASK_INSTRUCTION/);
    assert.ok(lines.slice(1).every((line) => !line.includes("\x1b")));
  } finally {
    terminal.stop();
  }
});

test("supports j/k selection, enter detail, escape return, and Ctrl-C quit", async () => {
  const service = fakeService([
    makeSnapshot({ id: "w1", agent: "alpha" }),
    makeSnapshot({ id: "w2", agent: "bravo", model: "m/y", thinking: "high", activity: "reading" }),
  ]);
  let quit = false;
  const { input, terminal } = startTerminal(service, () => {
    quit = true;
  });
  try {
    input.emit("data", "j");
    let lines = terminal.buildLines(120, 24);
    assert.ok(lines.some((line) => line.startsWith("▶") && line.includes("bravo")));

    input.emit("data", "\r");
    lines = terminal.buildLines(120, 24);
    assert.match(lines[0], /bravo/);
    assert.match(lines[0], /m\/y/);
    assert.match(lines[0], /high/);

    input.emit("data", "\x1b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    lines = terminal.buildLines(120, 24);
    assert.match(lines[0], /workers/);

    input.emit("data", "\x03");
    assert.equal(quit, true);
  } finally {
    terminal.stop();
  }
});

test("handles fragmented and lone escape sequences", async () => {
  const service = fakeService([
    makeSnapshot({ id: "w1", agent: "alpha" }),
    makeSnapshot({ id: "w2", agent: "bravo" }),
  ]);
  const { input, terminal } = startTerminal(service, () => {});
  try {
    input.emit("data", "\x1b[");
    input.emit("data", "B");
    let lines = terminal.buildLines(120, 24);
    assert.ok(lines.some((line) => line.startsWith("▶") && line.includes("bravo")));

    input.emit("data", "\r");
    assert.match(terminal.buildLines(120, 24)[0], /bravo/);
    input.emit("data", "\x1b");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.match(terminal.buildLines(120, 24)[0], /workers/);
  } finally {
    terminal.stop();
  }
});

test("terminal output failure requests shutdown without enabling raw mode after stop", () => {
  const service = fakeService([]);
  const out = new FakeOutput();
  out.write = () => { throw new Error("Output closed"); };
  const input = new FakeInput();
  let quitCalls = 0;
  const terminal = new SubagentTerminal({
    service,
    out: out as unknown as NodeJS.WriteStream,
    input: input as unknown as NodeJS.ReadStream,
    enabled: true,
    onQuit: () => {
      quitCalls += 1;
      if (quitCalls === 1) terminal.stop();
    },
  });
  try {
    terminal.start();
    assert.ok(quitCalls >= 1);
    assert.deepEqual(input.rawModes, []);
    assert.equal(input.listenerCount("data"), 0);
  } finally {
    terminal.stop();
  }
});

test("terminal catches up all retained transcript pages for an already idle worker", () => {
  const worker = makeSnapshot({ state: "idle" });
  const service = fakeService([worker]);
  const events: SubagentTranscriptEvent[] = Array.from({ length: 350 }, (_, index) => ({
    cursor: index + 1, timestamp: "", type: "assistant", data: { text: `line${index + 1}` },
  }));
  let requests = 0;
  service.inspectSubagent = (_id, cursor = 0, limit = 100) => {
    requests += 1;
    const page = events.filter((event) => event.cursor > cursor).slice(0, limit);
    return { worker, events: page, nextCursor: page.at(-1)?.cursor ?? cursor };
  };
  const { terminal } = startTerminal(service, () => {});
  try {
    assert.equal(requests, 4);
    assert.match(terminal.buildLines(120, 24).join("\n"), /line350/);
  } finally {
    terminal.stop();
  }
});

test("q asks before stopping workers and n, enter, or escape cancels", () => {
  let quitCalls = 0;
  const { input, terminal } = startTerminal(fakeService([makeSnapshot()]), () => { quitCalls += 1; });
  try {
    input.emit("data", "\r");
    for (const cancel of ["n", "N", "\r", "\x1b"]) {
      input.emit("data", "q");
      assert.match(terminal.buildLines(120, 24).at(-1) ?? "", /Quit and stop all workers/);
      input.emit("data", cancel);
      assert.equal(quitCalls, 0);
      assert.doesNotMatch(terminal.buildLines(120, 24).at(-1) ?? "", /Quit and stop all workers/);
      assert.match(terminal.buildLines(120, 24)[0], /alpha/);
    }
    input.emit("data", "qy");
    input.emit("data", "q");
    assert.equal(quitCalls, 0, "Pasted input or repeated q must not confirm");
    input.emit("data", "y");
    assert.equal(quitCalls, 1);
  } finally {
    terminal.stop();
  }
});

test("Ctrl-C still exits while quit confirmation is open", () => {
  let quit = false;
  const { input, terminal } = startTerminal(fakeService([]), () => { quit = true; });
  try {
    input.emit("data", "q");
    input.emit("data", "\x03");
    assert.equal(quit, true);
  } finally {
    terminal.stop();
  }
});

test("header shows live PSS and CPU metrics when sampled", () => {
  const { terminal } = startTerminal(fakeService([makeSnapshot()]), () => {});
  try {
    assert.match(terminal.buildLines(200, 24)[0], /pss \d+ MiB · cpu (\d+%|-)/);
  } finally {
    terminal.stop();
  }
});
