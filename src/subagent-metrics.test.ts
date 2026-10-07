import assert from "node:assert/strict";
import { test } from "node:test";

import { cpuPercentBetween, formatMetrics, sampleProcessTree, type ProcessTreeSample } from "./subagent-metrics.js";

test("formats metrics and CPU percent from sample deltas", () => {
  const sample: ProcessTreeSample = { pssMiB: 236.4, rssMiB: 300, cpuTicks: 1000, processes: 3 };
  assert.equal(formatMetrics(sample, 41.2), "pss 236 MiB · cpu 41%");
  assert.equal(formatMetrics(sample, undefined), "pss 236 MiB · cpu -");
  const previous: ProcessTreeSample = { ...sample, cpuTicks: 900 };
  assert.equal(cpuPercentBetween(previous, sample, 1000), 100);
  assert.equal(cpuPercentBetween(previous, sample, 2000), 50);
  assert.equal(cpuPercentBetween(sample, previous, 1000), undefined, "counter reset must not report negative CPU");
  assert.equal(cpuPercentBetween(previous, sample, 0), undefined);
});

test("samples the current process tree on Linux", { skip: process.platform !== "linux" }, () => {
  const sample = sampleProcessTree();
  assert.ok(sample.processes >= 1);
  assert.ok(sample.pssMiB > 0);
  assert.ok(sample.pssMiB <= sample.rssMiB);
  assert.ok(sample.cpuTicks > 0);
});
