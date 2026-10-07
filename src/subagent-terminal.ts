import type {
  SubagentSnapshot,
  SubagentTranscriptEvent,
  SubagentWorkerService,
} from "./subagent-contracts.js";

const RENDER_INTERVAL_MS = 100;
const TICK_INTERVAL_MS = 1000;
const ESCAPE_FLUSH_MS = 40;

const KNOWN_SEQUENCES = ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"] as const;

const TABLE_COLUMNS = [
  { key: "id", label: "ID", width: 9 },
  { key: "agent", label: "AGENT", width: 12 },
  { key: "state", label: "STATE", width: 9 },
  { key: "activity", label: "ACTIVITY", width: 20 },
  { key: "turns", label: "TURNS", width: 5, align: "right" as const },
  { key: "tools", label: "TOOLS", width: 5, align: "right" as const },
  { key: "elapsed", label: "ELAPSED", width: 9, align: "right" as const },
  { key: "tokens", label: "IN/OUT/CACHE", width: 16, align: "right" as const },
  { key: "ctx", label: "CTX", width: 5, align: "right" as const },
] as const;

const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESC_PATTERN = /\x1b[@-Z\\-_]/g;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function sanitize(value: string): string {
  return value
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESC_PATTERN, "")
    .replace(/\x1b/g, "")
    .replace(CONTROL_PATTERN, "");
}

export function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return "0";
  if (value < 1000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatContext(snapshot: SubagentSnapshot): string {
  if (typeof snapshot.contextPercent === "number") return `${Math.round(snapshot.contextPercent)}%`;
  if (typeof snapshot.contextTokens === "number") return formatTokens(snapshot.contextTokens);
  return "-";
}

function elapsedMs(snapshot: SubagentSnapshot, now: number): number {
  const start = Date.parse(snapshot.startedAt ?? snapshot.createdAt);
  if (Number.isNaN(start)) return 0;
  const end = snapshot.completedAt ? Date.parse(snapshot.completedAt) : now;
  return end - start;
}

function usageText(snapshot: SubagentSnapshot): string {
  const usage = snapshot.usage;
  return `${formatTokens(usage.input)}/${formatTokens(usage.output)}/${formatTokens(usage.cacheRead + usage.cacheWrite)}`;
}

export function workerSummary(snapshot: SubagentSnapshot, now: number): string {
  return sanitize(
    `${snapshot.id.slice(0, 8)} ${snapshot.agent} · ${snapshot.state} · ${snapshot.model}/${snapshot.thinking} · ctx ${formatContext(snapshot)} · turns ${snapshot.turns} · tools ${snapshot.toolUses} · ${formatDuration(elapsedMs(snapshot, now))}`,
  );
}

export function workerCell(
  snapshot: SubagentSnapshot,
  now: number,
): Record<(typeof TABLE_COLUMNS)[number]["key"], string> {
  return {
    id: sanitize(snapshot.id.slice(0, 8)),
    agent: sanitize(snapshot.agent),
    state: sanitize(snapshot.state),
    activity: sanitize(snapshot.activity ?? ""),
    turns: String(snapshot.turns),
    tools: String(snapshot.toolUses),
    elapsed: formatDuration(elapsedMs(snapshot, now)),
    tokens: usageText(snapshot),
    ctx: formatContext(snapshot),
  };
}

function pad(value: string, width: number, align: "left" | "right"): string {
  const text = value.length > width ? value.slice(0, Math.max(0, width - 1)) + "…" : value;
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

export function formatWorkerRow(snapshot: SubagentSnapshot, now: number): string {
  const cells = workerCell(snapshot, now);
  return TABLE_COLUMNS.map((column) => pad(cells[column.key], column.width, "align" in column ? column.align : "left")).join(" ");
}

export function formatTableHeader(): string {
  return TABLE_COLUMNS.map((column) => pad(column.label, column.width, "align" in column ? column.align : "left")).join(" ");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeJson(value: unknown, limit = 2000): string {
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return "";
  }
}

export function extractEventText(data: unknown, depth = 0): string {
  if (data == null) return "";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  if (depth > 6) return "";
  if (Array.isArray(data)) {
    return data
      .map((item) => extractEventText(item, depth + 1))
      .filter((part) => part.trim())
      .join("\n");
  }
  const record = data as Record<string, unknown>;
  const parts: string[] = [];
  const direct =
    readString(record.text) ??
    readString(record.content) ??
    readString(record.delta) ??
    readString(record.message) ??
    readString(record.output) ??
    readString(record.result) ??
    readString(record.summary);
  if (direct) {
    parts.push(direct);
  } else {
    for (const key of ["delta", "message", "content", "result", "output"]) {
      const value = record[key];
      if (value && typeof value === "object") {
        const nested = extractEventText(value, depth + 1);
        if (nested.trim()) parts.push(nested);
      }
    }
  }
  if (Array.isArray(record.parts)) parts.push(extractEventText(record.parts, depth + 1));
  const toolName = readString(record.name) ?? readString(record.tool);
  if (toolName) {
    const args = record.input ?? record.arguments;
    parts.push(args === undefined ? toolName : `${toolName}(${safeJson(args)})`);
  }
  if (record.error !== undefined && record.error !== null) {
    parts.push(readString(record.error) ?? safeJson(record.error));
  }
  const joined = parts.filter((part) => part.trim()).join("\n");
  if (joined.trim()) return joined;
  return safeJson(data);
}

export function formatEventLine(event: SubagentTranscriptEvent): string {
  const type = sanitize(event.type);
  const text = sanitize(extractEventText(event.data)).replace(/\s+/g, " ").trim();
  return `#${event.cursor} ${type}${text ? ` ${text}` : ""}`;
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.length) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/(\s+)/)) {
      if (line && line.length + word.length > width) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line += word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

export function formatEventLines(event: SubagentTranscriptEvent, width: number): string[] {
  const prefix = `#${event.cursor} ${sanitize(event.type)}`;
  const text = sanitize(extractEventText(event.data)).trim();
  if (!text) return [prefix];
  const wrapped = wrapText(text, Math.max(8, width - 2));
  if (wrapped.length === 1) return [`${prefix} ${wrapped[0]}`];
  return [prefix, ...wrapped.map((line) => `  ${line}`)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  return line.slice(0, Math.max(0, width - 1)) + "…";
}

interface TranscriptState {
  cursor?: number;
  events: SubagentTranscriptEvent[];
}

export interface SubagentTerminalOptions {
  service: SubagentWorkerService;
  out?: NodeJS.WriteStream;
  err?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
  title?: string;
  enabled?: boolean;
  maxEvents?: number;
  transcriptBatch?: number;
  onQuit?: () => void;
}

export class SubagentTerminal {
  private readonly service: SubagentWorkerService;
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private readonly input: NodeJS.ReadStream;
  private readonly title: string;
  private readonly enabled: boolean;
  private readonly maxEvents: number;
  private readonly transcriptBatch: number;
  private readonly onQuit: (() => void) | undefined;

  private started = false;
  private rawMode = false;
  private ansiActive = false;
  private unsubscribe: (() => void) | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  private escapeTimer: NodeJS.Timeout | undefined;
  private renderScheduled = false;
  private dirty = false;
  private transcriptDirty = false;
  private pendingInput = "";
  private lastStates = new Map<string, string>();

  private workers: SubagentSnapshot[] = [];
  private selectedId: string | undefined;
  private mode: "list" | "detail" = "list";
  private quitConfirmation = false;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private readonly transcripts = new Map<string, TranscriptState>();

  private exitResolve: (() => void) | undefined;
  private readonly exited: Promise<void>;

  constructor(options: SubagentTerminalOptions) {
    this.service = options.service;
    this.out = options.out ?? process.stdout;
    this.err = options.err ?? process.stderr;
    this.input = options.input ?? process.stdin;
    this.title = options.title ?? "pi-subagents";
    this.enabled = options.enabled ?? Boolean(this.out.isTTY && this.input.isTTY);
    this.maxEvents = options.maxEvents ?? 400;
    this.transcriptBatch = options.transcriptBatch ?? 100;
    this.onQuit = options.onQuit;
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshWorkers();
    this.unsubscribe = this.service.subscribe(() => this.onServiceChange());
    if (!this.enabled) {
      this.logLifecycle();
      return;
    }
    this.ansiActive = true;
    this.write("\x1b[?1049h\x1b[?25l");
    if (!this.started) return;
    if (this.input.isTTY && typeof this.input.setRawMode === "function") {
      this.input.setRawMode(true);
      this.rawMode = true;
    }
    this.input.setEncoding("utf8");
    this.input.resume();
    this.input.on("data", this.onInput);
    process.once("exit", this.restoreSync);
    this.tickTimer = setInterval(() => this.onTick(), TICK_INTERVAL_MS);
    this.tickTimer.unref();
    this.dirty = true;
    this.transcriptDirty = true;
    this.paint();
  }

  stop(): void {
    if (!this.started) {
      this.exitResolve?.();
      return;
    }
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.renderScheduled = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    if (this.enabled) {
      this.input.off("data", this.onInput);
      if (this.rawMode && typeof this.input.setRawMode === "function") this.input.setRawMode(false);
      this.rawMode = false;
      this.input.pause();
      process.off("exit", this.restoreSync);
      this.ansiActive = false;
      this.write("\x1b[?25h\x1b[?1049l");
    }
    this.exitResolve?.();
  }

  whenExited(): Promise<void> {
    return this.exited;
  }

  private write(text: string): void {
    if (!this.out.writable) return;
    try {
      this.out.write(text);
    } catch {
      this.onQuit?.();
    }
  }

  private readonly restoreSync = (): void => {
    if (!this.ansiActive) return;
    this.ansiActive = false;
    try {
      this.out.write("\x1b[?25h\x1b[?1049l");
    } catch {
    }
  };

  private onServiceChange(): void {
    this.refreshWorkers();
    this.dirty = true;
    this.transcriptDirty = true;
    if (!this.enabled) {
      this.logLifecycle();
      return;
    }
    this.scheduleRender();
  }

  private onTick(): void {
    if (this.workers.some((worker) => worker.state === "running" || worker.state === "starting")) {
      this.dirty = true;
      this.scheduleRender();
    }
  }

  private scheduleRender(): void {
    if (!this.enabled || this.renderScheduled) return;
    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      if (!this.dirty) return;
      this.dirty = false;
      this.paint();
    }, RENDER_INTERVAL_MS);
  }

  private refreshWorkers(): void {
    try {
      this.workers = this.service.listSubagents();
    } catch {
      return;
    }
    const live = new Set(this.workers.map((worker) => worker.id));
    for (const id of [...this.transcripts.keys()]) {
      if (!live.has(id)) this.transcripts.delete(id);
    }
    if (this.selectedId && !live.has(this.selectedId)) this.selectedId = undefined;
    if (!this.selectedId && this.workers.length) this.selectedId = this.workers[0].id;
  }

  private selectedWorker(): SubagentSnapshot | undefined {
    if (!this.selectedId) return undefined;
    return this.workers.find((worker) => worker.id === this.selectedId);
  }

  private transcriptFor(id: string): TranscriptState {
    let state = this.transcripts.get(id);
    if (!state) {
      state = { events: [] };
      this.transcripts.set(id, state);
    }
    return state;
  }

  private refreshTranscript(id: string): void {
    const state = this.transcriptFor(id);
    try {
      let hasMore = true;
      while (hasMore) {
        const cursor = state.cursor ?? 0;
        const inspection = this.service.inspectSubagent(id, cursor, this.transcriptBatch);
        state.cursor = inspection.nextCursor;
        if (inspection.events.length) state.events.push(...inspection.events);
        if (state.events.length > this.maxEvents) state.events.splice(0, state.events.length - this.maxEvents);
        hasMore = inspection.events.length >= this.transcriptBatch && inspection.nextCursor > cursor;
      }
    } catch {
    }
  }

  private paint(): void {
    if (!this.enabled) return;
    if (this.transcriptDirty) {
      this.transcriptDirty = false;
      if (this.selectedId) this.refreshTranscript(this.selectedId);
    }
    const width = this.out.columns ?? 100;
    const height = this.out.rows ?? 30;
    const lines = this.buildLines(width, height);
    const painted = lines.map((line) => `\x1b[K${truncateLine(line, width)}`).join("\n");
    this.write(`\x1b[H${painted}`);
  }

  buildLines(width: number, height: number): string[] {
    const now = Date.now();
    const content = Math.max(3, height - 1);
    const body = this.mode === "detail" ? this.buildDetailLines(width, content, now) : this.buildListLines(width, content, now);
    const footer = this.quitConfirmation
      ? "Quit and stop all workers? [y/N] · esc cancel"
      : this.mode === "detail"
        ? "esc back · ↑/↓ j/k scroll · g/G top/bottom · q quit"
        : "↑/↓ j/k select · enter detail · r refresh · q quit";
    const padded = body.slice(0, content);
    while (padded.length < content) padded.push("");
    return [...padded, truncateLine(footer, width)];
  }

  private buildListLines(width: number, content: number, now: number): string[] {
    const lines: string[] = [];
    const running = this.workers.filter((w) => w.state === "running" || w.state === "starting").length;
    lines.push(truncateLine(`${this.title}  ${this.workers.length} workers · ${running} active`, width));
    const selected = this.selectedWorker();
    lines.push(selected ? truncateLine(workerSummary(selected, now), width) : "");
    lines.push(truncateLine(formatTableHeader(), width));

    const outputHeight = clamp(Math.floor(content / 3), 4, 10);
    const tableHeight = Math.max(1, content - 3 - outputHeight - 1);
    const selectedIndex = Math.max(0, this.workers.findIndex((worker) => worker.id === this.selectedId));
    const maxStart = Math.max(0, this.workers.length - tableHeight);
    const start = clamp(selectedIndex - Math.floor(tableHeight / 2), 0, maxStart);
    const visible = this.workers.slice(start, start + tableHeight);
    for (let index = 0; index < tableHeight; index += 1) {
      const worker = visible[index];
      if (!worker) {
        lines.push("");
        continue;
      }
      const pointer = worker.id === this.selectedId ? "▶" : " ";
      lines.push(truncateLine(`${pointer}${formatWorkerRow(worker, now)}`, width));
    }

    lines.push(truncateLine(`recent output${selected ? ` · ${selected.id.slice(0, 8)}` : ""}`, width));
    const events = this.selectedId ? this.transcriptFor(this.selectedId).events.slice(-outputHeight) : [];
    const output: string[] = [];
    for (const event of events) {
      for (const line of formatEventLines(event, width)) output.push(`  ${line}`);
    }
    const window = output.slice(-outputHeight);
    for (let index = window.length; index < outputHeight; index += 1) lines.push("");
    for (const line of window) lines.push(truncateLine(line, width));

    return lines.slice(0, content);
  }

  private buildDetailLines(width: number, content: number, now: number): string[] {
    const lines: string[] = [];
    const worker = this.selectedWorker();
    if (!worker) {
      this.detailMaxScroll = 0;
      this.detailScroll = 0;
      lines.push(truncateLine(`${this.title}  worker not available`, width));
      return lines;
    }
    lines.push(truncateLine(workerSummary(worker, now), width));
    const viewHeight = Math.max(1, content - 1);
    const events = this.transcriptFor(worker.id).events;
    const wrapped: string[] = [];
    for (const event of events) for (const line of formatEventLines(event, width)) wrapped.push(line);
    this.detailMaxScroll = Math.max(0, wrapped.length - viewHeight);
    this.detailScroll = clamp(this.detailScroll, 0, this.detailMaxScroll);
    const end = Math.max(0, wrapped.length - this.detailScroll);
    const start = Math.max(0, end - viewHeight);
    const window = wrapped.slice(start, end);
    for (let index = 0; index < viewHeight; index += 1) {
      const line = window[index];
      lines.push(line ? truncateLine(line, width) : "");
    }
    return lines.slice(0, content);
  }

  private moveSelection(delta: number): void {
    if (!this.workers.length) return;
    const current = Math.max(0, this.workers.findIndex((worker) => worker.id === this.selectedId));
    const next = clamp(current + delta, 0, this.workers.length - 1);
    const worker = this.workers[next];
    if (!worker || worker.id === this.selectedId) return;
    this.selectedId = worker.id;
    this.transcriptDirty = true;
    this.dirty = true;
    this.scheduleRender();
  }

  private readonly onInput = (chunk: string | Buffer): void => {
    this.pendingInput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.processInput();
  };

  private processInput(): void {
    const data = this.pendingInput;
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (this.quitConfirmation) {
        this.pendingInput = "";
        if (char === "y" || char === "Y" || char === "\x03") {
          this.requestExit();
        } else if (char === "n" || char === "N" || char === "\x1b" || char === "\r" || char === "\n") {
          this.quitConfirmation = false;
          this.dirty = true;
          this.scheduleRender();
        }
        return;
      }
      if (char === "\x1b") {
        const rest = data.slice(index);
        const known = KNOWN_SEQUENCES.find((sequence) => rest.startsWith(sequence));
        if (known) {
          this.handleSequence(known);
          index += known.length;
          continue;
        }
        if (KNOWN_SEQUENCES.some((sequence) => sequence.startsWith(rest))) break;
        this.handleEscape();
        index += 1;
        continue;
      }
      if (char === "k") this.handleUp();
      else if (char === "j") this.handleDown();
      else if (char === "\r" || char === "\n") this.handleEnter();
      else if (char === "\x03") {
        this.pendingInput = "";
        this.requestExit();
        return;
      } else if (char === "q") {
        this.pendingInput = "";
        this.quitConfirmation = true;
        this.dirty = true;
        this.scheduleRender();
        return;
      } else if (char === "r") {
        this.refreshWorkers();
        this.dirty = true;
        this.transcriptDirty = true;
        this.scheduleRender();
      } else if (char === "g") {
        if (this.mode === "detail") {
          this.detailScroll = this.detailMaxScroll;
          this.dirty = true;
          this.scheduleRender();
        }
      } else if (char === "G") {
        if (this.mode === "detail") {
          this.detailScroll = 0;
          this.dirty = true;
          this.scheduleRender();
        }
      }
      index += 1;
    }
    this.pendingInput = data.slice(index);
    this.armEscapeFlush();
  }

  private armEscapeFlush(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }
    if (!this.pendingInput.startsWith("\x1b")) return;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      if (!this.pendingInput.startsWith("\x1b")) return;
      this.pendingInput = "";
      this.handleEscape();
    }, ESCAPE_FLUSH_MS);
  }

  private handleSequence(sequence: (typeof KNOWN_SEQUENCES)[number]): void {
    if (sequence === "\x1b[A") this.handleUp();
    else if (sequence === "\x1b[B") this.handleDown();
    else if (sequence === "\x1b[5~") this.page(-1);
    else if (sequence === "\x1b[6~") this.page(1);
  }

  private page(direction: -1 | 1): void {
    if (this.mode === "detail") {
      this.detailScroll = clamp(this.detailScroll - direction * 10, 0, this.detailMaxScroll);
      this.dirty = true;
      this.scheduleRender();
      return;
    }
    this.moveSelection(direction * 10);
  }

  private handleUp(): void {
    if (this.mode === "detail") {
      this.detailScroll = clamp(this.detailScroll + 1, 0, this.detailMaxScroll);
      this.dirty = true;
      this.scheduleRender();
      return;
    }
    this.moveSelection(-1);
  }

  private handleDown(): void {
    if (this.mode === "detail") {
      this.detailScroll = clamp(this.detailScroll - 1, 0, this.detailMaxScroll);
      this.dirty = true;
      this.scheduleRender();
      return;
    }
    this.moveSelection(1);
  }

  private handleEnter(): void {
    if (this.mode === "list" && this.selectedId) {
      this.mode = "detail";
      this.detailScroll = 0;
      this.transcriptDirty = true;
      this.dirty = true;
      this.scheduleRender();
    }
  }

  private handleEscape(): void {
    if (this.mode === "detail") {
      this.mode = "list";
      this.detailScroll = 0;
      this.dirty = true;
      this.scheduleRender();
    }
  }

  private requestExit(): void {
    this.onQuit?.();
  }

  private logLifecycle(): void {
    const nextStates = new Map(this.workers.map((worker) => [worker.id, worker.state]));
    const changes: string[] = [];
    for (const worker of this.workers) {
      const previous = this.lastStates.get(worker.id);
      if (previous !== worker.state) {
        changes.push(`${worker.id.slice(0, 8)} ${sanitize(worker.agent)} ${previous ?? "new"} -> ${worker.state}`);
      }
    }
    for (const previousId of this.lastStates.keys()) {
      if (!nextStates.has(previousId)) changes.push(`${previousId.slice(0, 8)} released`);
    }
    this.lastStates = nextStates;
    if (!changes.length) return;
    for (const change of changes) {
      try {
        this.err.write(`[pi-subagents] ${change}\n`);
      } catch {
        return;
      }
    }
  }
}
