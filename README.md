# swarmd

A single-binary MCP service that owns a shared pool of Pi worker sessions. Claude Code, Pi, and other MCP clients connect over Streamable HTTP and share the same workers. The service draws a live terminal view. It needs no tmux, no browser, and no parent model of its own.

## Install

Build from source. Requires [Bun](https://bun.sh) for building only; the shipped binary embeds its own runtime.

```sh
git clone git@github.com:PS-Wizard/swarmd.git ~/swarmd
cd ~/swarmd
bun install
bun run install:local
```

`install:local` builds the binary and copies it to `~/.config/swarmd/swarmd`. Add the launcher to your PATH once:

```sh
mkdir -p ~/.local/bin
ln -sfn ~/.config/swarmd/swarmd ~/.local/bin/swarmd
```

Then copy the templates and edit them:

```sh
mkdir -p ~/.config/swarmd/agents
cp -n templates/config.json templates/SUBAGENT_INSTRUCTIONS.md ~/.config/swarmd/
cp -n templates/agents/*.md ~/.config/swarmd/agents/
```

Adjust `model` lines in the agent files to models you have credentials for.

## Run

```sh
swarmd
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. Keep it running in a terminal or tmux pane. `swarmd --help` lists the options, and `--no-ui` logs lifecycle events to stderr instead of drawing the view.

The binary reads its configuration, agent files, and instructions from disk at startup, so you can edit them without rebuilding. Only code changes need a rebuild.

On Linux, the header shows live memory and CPU for the service and its child processes, refreshed every five seconds. `pss` counts shared pages once, and `cpu` is whole-tree CPU where 100% is one busy core. Other platforms omit both.

The service binds to localhost. Every connected client can control every worker, so do not expose the port to an untrusted network. Workers are not sandboxed: their file tools and shell commands run with your permissions. The concurrency limit is not a security boundary.

## Layout

```
~/.config/swarmd/
  swarmd                        the binary
  config.json                   service configuration
  agents/*.md                   worker definitions
  SUBAGENT_INSTRUCTIONS.md      instructions shared by all workers
~/.local/bin/swarmd             launcher
~/.agents/skills/               skills, in the Agent Skills standard location
```

Skills live outside this tool on purpose. Pi reads `~/.agents/skills/` natively, so the same skill files serve Pi sessions and swarmd workers, and neither one owns them.

## Terminal controls

Use `j`/`k` or the arrow keys to select a worker. Press Enter to open its output and Escape to return to the list. In the output view, `j`/`k` scroll and `g`/`G` jump to the start or end, and the task prompt given by the MCP caller stays pinned at the top. Press `q` to request shutdown, then `y` to confirm. Press `n`, Enter, or Escape to cancel. Ctrl-C shuts down immediately.

The list shows state, activity, model, thinking level, elapsed time, token usage, and context usage where available.

## Configuration

Default path: `~/.config/swarmd/config.json`, or `$XDG_CONFIG_HOME/swarmd/config.json` when that variable is set. There are no project-level overrides. Use `--config /path/to/config.json` to point at another file.

```json
{
  "agentsDir": "~/.config/swarmd/agents",
  "skillsDir": "~/.agents/skills",
  "workerInstructionsFile": "~/.config/swarmd/SUBAGENT_INSTRUCTIONS.md",
  "piAgentDir": "~/.config/pi",
  "excludeExtensions": ["mcp"],
  "port": 8787,
  "maxConcurrent": 20,
  "transcripts": "memory",
  "transcriptDir": "~/.config/swarmd/transcripts"
}
```

`piAgentDir` selects the installed Pi resources, provider configuration, credentials, and extensions that workers load. Keep credentials out of this repository.

`transcripts` sets where streamed events go. `"memory"` is the default and writes nothing to disk. `"disk"` appends one JSONL file per worker under `transcriptDir` for debugging, at the cost of a file write per streamed chunk. The terminal view and `inspect_subagent` work in both modes.

`excludeExtensions` skips named extensions. Worker-side MCP is excluded by default so workers cannot call MCP servers.

Restart the service after changing configuration, installed extensions, or shared instructions. Agent definitions reload on each list or spawn, so those need no restart.

The `cwd` given to a task selects where tools operate. It does not enable configuration, agent, skill, extension, or `AGENTS.md` discovery from that project.

## Agent definitions

Add a Markdown file to `agentsDir`. The filename is the agent name.

```markdown
---
description: Focused implementation, debugging, and tests.
model: opencode-go/deepseek-v4.1-flash
thinking: high
---

You are an implementation worker. Inspect the relevant code, make the smallest
correct change, and validate it with focused tests. Report changed files and blockers.
```

`description` helps the caller pick an agent. The body instructs the worker. `model` is pinned by the definition. `thinking` is optional and can also be set per task or later through MCP; unsupported levels are rejected.

Workers receive the shared instructions plus the agent body. They do not inherit the parent conversation or any project `AGENTS.md`. Skills are advertised by name, description, and path, and workers read the full instructions only when a task calls for them.

Installed extensions load unless excluded. Extensions that need an interactive Pi terminal will not work headlessly; the service records their load errors, which `inspect_subagent` returns as `extension_error` events.

## MCP client setup

Claude Code:

```sh
claude mcp add --transport http --scope user swarmd http://127.0.0.1:8787/mcp
```

Pi, in `~/.config/pi/mcp.json`:

```json
{
  "mcpServers": {
    "swarmd": {
      "url": "http://127.0.0.1:8787/mcp",
      "exposure": "codemode",
      "timeout": 600
    }
  }
}
```

Other clients may want `"type": "http"` or `"type": "streamable-http"`. Set a client request timeout long enough for heavy waiting calls. The service never edits your client configuration.

## Tools

| Tool | Action |
| --- | --- |
| `list_agents` | Read definitions, models, and thinking levels |
| `spawn_subagents` | Queue one or several tasks and return IDs immediately |
| `list_subagents` | Read worker states, activity, turns, usage, and context |
| `inspect_subagent` | Read one worker and a page of transcript events |
| `send_subagent` | Steer active work or submit another task to an idle worker |
| `configure_subagent` | Set thinking for subsequent requests |
| `stop_subagents` | Cancel selected work while retaining workers |
| `wait_subagents` | Wait for any or all selected tasks to finish |
| `get_subagent_results` | Fetch available results immediately |
| `release_subagents` | Dispose selected workers and free session resources |

Spawn:

```json
{
  "tasks": [
    {
      "agent": "deepseek",
      "prompt": "Inspect the authentication code and report defects. Do not edit files.",
      "cwd": "/absolute/path/to/repository",
      "description": "Inspect authentication"
    }
  ]
}
```

Wait:

```json
{
  "ids": ["worker-id"],
  "type": "all",
  "timeoutSeconds": 300
}
```

With one ID, `any` and `all` behave the same. With several, `any` returns once at least one task is terminal. Already finished tasks return immediately, so pass the remaining IDs to the next wait. Stopped and failed tasks count as finished and carry their real status.

`timeoutSeconds` is optional and capped at 3600. Omitting it means the wait has no deadline and settles only on a state change, cancellation, or release. A timed-out wait returns `timedOut: true` and leaves workers running.

Waiting is event-driven, not polling. Cancelling or timing out a wait does not stop workers. Nothing wakes the calling agent on its own: a caller learns results through a wait or a retrieval call. Terminal updates cost no model tokens.

## Worker lifetime

`maxConcurrent` tasks start or run at once; the rest queue. Idle workers keep their conversation in memory until released. SDK sessions use `SessionManager.inMemory`, so they create no Pi session files and never appear in `pi -r`.

`stop_subagents` cancels work without undoing edits. `release_subagents` rejects active workers unless `force: true`. Releasing frees the SDK session. Workers do not survive a service restart or, in memory mode, leave a transcript behind.

Workers share the working directory. There are no file locks or Git worktrees, so divide write tasks by file ownership to avoid conflicts.

Token usage reports input, output, cache reads, and cache writes separately. Context usage is an estimate when Pi supplies it, not a lifetime total. A worker's available thinking levels come from its model metadata.

## Memory

Measured on this machine with a real 20-worker implementation task, all workers in one process:

| State | PSS |
| --- | ---: |
| Idle service | ~104 MiB |
| 20 active workers, peak | ~479 MiB |

That is roughly 21 MiB per active session above the idle baseline. Released workers free their live heap, but process RSS does not return to the idle level because the allocator keeps pages. Transcripts default to memory mode partly because one 20-worker run produced over 10,000 streamed events per busy worker.

## Development

```sh
bun run check          # type check
bun run test           # unit and integration tests, no paid model calls
bun run build:binary   # compile the single binary into dist/swarmd
bun run test:binary    # run the compiled binary against a local mock model
```

`bun run test` uses fake worker sessions and local MCP clients. `test:binary` boots the real compiled binary, checks that installed extensions load, runs one worker through MCP against a local mock model, and confirms nothing is written to disk. Neither script calls a paid API.

`test/smoke-installed-plugins.mjs` exercises your installed FFF, hashline, TinyFish, and codemode extensions with two concurrent workers, also against a local mock model.
