#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const pid = Number(process.argv[2]);
assert.ok(Number.isInteger(pid) && pid > 0, "Provide the running service PID");
const output = process.argv[3] ?? "/tmp/pi-subagents-real-memory.json";
const client = new Client({ name: "real-memory-check", version: "1.0" });
const samples = [];
let phase = "baseline";
let ids = [];
let timer;
let results;
let released = false;

function payload(response) {
  assert.notEqual(response.isError, true, JSON.stringify(response));
  return response.structuredContent ?? JSON.parse(response.content.find((item) => item.type === "text").text);
}
function sample() {
  const descendants = new Set([pid]);
  for (const processId of descendants) {
    try {
      for (const tid of readdirSync(`/proc/${processId}/task`)) {
        const children = readFileSync(`/proc/${processId}/task/${tid}/children`, "utf8").trim();
        for (const child of children.split(/\s+/).filter(Boolean)) descendants.add(Number(child));
      }
    } catch {}
  }
  const row = { phase, timestamp: new Date().toISOString(), rssMiB: 0, pssMiB: 0, treeRssMiB: 0, treePssMiB: 0, processes: 0 };
  for (const processId of descendants) {
    try {
      const smaps = readFileSync(`/proc/${processId}/smaps_rollup`, "utf8");
      const value = (key) => Number(smaps.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1] ?? 0) / 1024;
      const rss = value("Rss"), pss = value("Pss");
      row.treeRssMiB += rss; row.treePssMiB += pss; row.processes += 1;
      if (processId === pid) { row.rssMiB = rss; row.pssMiB = pss; }
    } catch {}
  }
  samples.push(row);
}
function save(status) {
  writeFileSync(output, JSON.stringify({ status, pid, ids, results, samples }, null, 2));
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp")));
  sample();
  timer = setInterval(sample, 500);
  const topics = [
    ["Queue and cancellation", "src/subagent-service.ts and src/subagent-service.test.ts", "How does the concurrency limit apply to queued, starting, running, and cancelled workers?"],
    ["SDK resources and cleanup", "src/subagent-runtime.ts and src/subagent-runtime.test.ts", "How are global extensions and skills loaded without project resources? What gets disposed on release?"],
    ["HTTP MCP safety", "src/subagent-mcp.ts and src/subagent-mcp.test.ts", "What protects the localhost HTTP server from cross-origin requests, excess sessions, and abandoned waits?"],
    ["Agent configuration", "src/subagent-config.ts and src/subagent-definitions.ts", "How are paths, model names, and thinking levels validated? Identify one configuration limitation."],
    ["Terminal transcript view", "src/subagent-terminal.ts and src/subagent-terminal.test.ts", "How does the terminal display live output while limiting memory and catching up transcript pages?"],
  ];
  const tasks = ["deepseek", "muse"].flatMap((agent) => topics.map(([description, files, question], index) => ({
    agent, thinking: agent === "deepseek" ? ["low", "high", "max", "low", "high"][index] : ["minimal", "low", "medium", "high", "xhigh"][index],
    cwd: "/home/wizard/Projects/pi-subagents-mcp", description: `Real memory check: ${description}`,
    prompt: `This is a read-only real-model memory and tool-execution check. Do not edit or create files, run builds/tests, access credentials, use image/search APIs, or start other agents. First use read to open /home/wizard/.config/pi/skills/ponytail/SKILL.md and quote one rule in your final report. Then use file/search tools to inspect ${files}; read both files and search one relevant identifier. ${question} Report findings with file references in at most 150 words. Do not change anything.`,
  })));
  phase = "active";
  const spawned = payload(await client.callTool({ name: "spawn_subagents", arguments: { tasks } }));
  const outcomes = spawned.outcomes;
  assert.ok(Array.isArray(outcomes), JSON.stringify(spawned));
  ids = outcomes.filter((item) => item.success).map((item) => item.worker.id);
  save("running");
  console.log(JSON.stringify({ status: "running", ids, output }));
  assert.equal(ids.length, 10, JSON.stringify(spawned));
  for (let index = 0; index < outcomes.length; index++) assert.equal(outcomes[index].worker.thinking, tasks[index].thinking);
  for (const [index, bad, good] of [[0, "xhigh", "high"], [5, "max", "medium"]]) {
    const rejected = await client.callTool({ name: "configure_subagent", arguments: { id: ids[index], thinking: bad } });
    assert.equal(rejected.isError, true, "Unsupported thinking must be rejected");
    const changed = payload(await client.callTool({ name: "configure_subagent", arguments: { id: ids[index], thinking: good } }));
    console.log(JSON.stringify({ status: "thinking-changed", id: ids[index], rejected: bad, accepted: good, changed }));
  }
  const waited = payload(await client.callTool({ name: "wait_subagents", arguments: { ids, type: "all", timeoutSeconds: 300 } }, undefined, { timeout: 360000, resetTimeoutOnProgress: true }));
  console.log(JSON.stringify({ status: "wait-complete", waited }));
  results = payload(await client.callTool({ name: "get_subagent_results", arguments: { ids } }));
  assert.equal(waited.timedOut, false, "Real workers exceeded the five-minute test deadline");
  const inspections = [];
  for (const id of ids) {
    const inspection = payload(await client.callTool({ name: "inspect_subagent", arguments: { id, cursor: 0, limit: 500 } }));
    inspections.push(inspection);
    assert.equal(inspection.worker.state, "idle", JSON.stringify(inspection.worker));
    const events = readFileSync(inspection.worker.transcriptPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.type === "message" && event.data?.role === "toolResult" && event.data?.tool === "read" && event.data?.text?.includes("name: ponytail")), "Transcript must contain the actual skill read result");
  }
  writeFileSync(output.replace(/\.json$/, "-inspections.json"), JSON.stringify(inspections, null, 2));
  for (const [index, thinking] of [[0, "low"], [5, "high"]]) {
    payload(await client.callTool({ name: "configure_subagent", arguments: { id: ids[index], thinking } }));
    payload(await client.callTool({ name: "send_subagent", arguments: { id: ids[index], message: "Read /home/wizard/.config/pi/skills/write-discoverable-code/SKILL.md using your read tool. Give one applicable rule in under60words. Read-only, no file changes." } }));
  }
  const resumed = payload(await client.callTool({ name: "wait_subagents", arguments: { ids: [ids[0], ids[5]], type: "all", timeoutSeconds: 180 } }, undefined, { timeout: 240000, resetTimeoutOnProgress: true }));
  assert.equal(resumed.timedOut, false, "Resumed workers exceeded the three-minute deadline");
  assert.ok(resumed.finished.every((worker) => worker.state === "idle" && worker.generation === 2));
  results = payload(await client.callTool({ name: "get_subagent_results", arguments: { ids } }));
  phase = "retained";
  await delay(3000);
  const release = payload(await client.callTool({ name: "release_subagents", arguments: { ids, force: true } }));
  released = true;
  console.log(JSON.stringify({ status: "released", release }));
  phase = "released";
  await delay(10000);
  sample();
  save("complete");
  console.log(JSON.stringify({ status: "complete", output, peaks: {
    rssMiB: Math.max(...samples.map((row) => row.rssMiB)), pssMiB: Math.max(...samples.map((row) => row.pssMiB)),
    treeRssMiB: Math.max(...samples.map((row) => row.treeRssMiB)), treePssMiB: Math.max(...samples.map((row) => row.treePssMiB)),
  }, baseline: samples[0], afterRelease: samples.at(-1) }));
} catch (error) {
  console.error(error);
  save(`failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  if (ids.length && !released) {
    try { await client.callTool({ name: "release_subagents", arguments: { ids, force: true } }); } catch (error) { console.error("Cleanup failed:", error); }
  }
  await client.close();
}
