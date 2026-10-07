import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCliArgs } from "./subagent-cli.js";

test("parses config, port, max-concurrent, and no-ui", () => {
  const options = parseCliArgs(["--config", "/tmp/config.json", "--port", "8787", "--max-concurrent", "4", "--no-ui"]);
  assert.deepEqual(options, {
    help: false,
    configPath: "/tmp/config.json",
    port: 8787,
    maxConcurrent: 4,
    noUi: true,
  });
});

test("supports the help short flag and empty arguments", () => {
  assert.equal(parseCliArgs(["-h"]).help, true);
  assert.deepEqual(parseCliArgs([]), { help: false, configPath: undefined, port: undefined, maxConcurrent: undefined, noUi: false });
});

test("rejects invalid numeric options", () => {
  assert.throws(() => parseCliArgs(["--port", "0"]));
  assert.throws(() => parseCliArgs(["--port", "abc"]));
  assert.throws(() => parseCliArgs(["--max-concurrent", "0"]));
});
