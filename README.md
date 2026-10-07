# Pi subagents MCP

A manually started Node service for Pi SDK workers. Claude Code, Pi, and other MCP clients use the same worker pool through Streamable HTTP. The service shows workers in the terminal. It does not require tmux pane markers, a browser, or a parent model inside the service.

## Install and start

Requires Node 22.19 or newer. Bun is used for package installation, not as the runtime.

For a new installation, copy the examples without replacing existing files, then adjust their paths and model IDs:

```sh
mkdir -p ~/.config/pi-subagents-mcp/agents
cp -n examples/config.json examples/SUBAGENT_INSTRUCTIONS.md ~/.config/pi-subagents-mcp/
cp -n examples/agents/*.md ~/.config/pi-subagents-mcp/agents/
```

If you use `XDG_CONFIG_HOME`, use that directory and update the paths in the example configuration.

```sh
bun install
bun run build
./pi-subagents-mcp --port 8787
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. Keep the service running in a terminal or tmux pane. Use `--help` for options and `--no-ui` for plain terminal output.

The service binds to localhost. Clients connected to the service share its worker pool and can control its workers. Do not expose the port to an untrusted network. Workers are not sandboxed: file tools and shell commands have your user's permissions. The concurrency limit is not a security boundary.

## Terminal controls

Use `j`/`k` or the arrow keys to select a worker. Press Enter to open its output and Escape to return to the worker list. In the output view, `j`/`k` scroll and `g`/`G` jump to the start or end. Press `q` or Ctrl-C to shut down the service. The view shows turns, tool activity, model/thinking, elapsed time, token usage, and context usage where available.

## Global configuration

Default configuration: `~/.config/pi-subagents-mcp/config.json`. The default location follows `XDG_CONFIG_HOME` when set. There are no project configuration overrides. Use `--config /path/to/config.json` to select another global configuration file.

```json
{
  "agentsDir": "~/.config/pi-subagents-mcp/agents",
  "skillsDir": "~/.config/pi/skills",
  "workerInstructionsFile": "~/.config/pi-subagents-mcp/SUBAGENT_INSTRUCTIONS.md",
  "piAgentDir": "~/.config/pi",
  "excludeExtensions": ["pi-subagents", "mcp"],
  "port": 8787,
  "maxConcurrent": 10,
  "transcriptDir": "~/.config/pi-subagents-mcp/transcripts"
}
```

`piAgentDir` selects installed Pi resources, provider configuration, and credentials. Keep credentials out of this repository. `agentsDir` and `skillsDir` are separate configurable directories, and can point to shared directories or symlinks.

Restart the service after changing configuration, installed extensions, or shared worker instructions. Agent definitions reload without a restart.

The working directory supplied for a task selects where tools operate. It does not enable configuration, agent, skill, extension, or `AGENTS.md` discovery from that project.

## Agent definitions

Add Markdown files to `agentsDir`. The filename is the agent name. Definitions reload when agents are listed or tasks are spawned.

```markdown
---
description: Focused implementation, debugging, and tests.
model: opencode-go/deepseek-v4.1-flash
thinking: high
---

You are an implementation worker. Inspect the relevant code, make the smallest
correct change, and validate it with focused tests. Report changed files and blockers.
```

`description` helps the caller select an agent. The body gives instructions to the worker. `model` is pinned by the definition. `thinking` is optional and can be changed through MCP.

Common worker instructions come from `workerInstructionsFile`. Parent conversations and `AGENTS.md` files are not inherited. Skills are advertised by name, description, and path; workers read full skill instructions when needed.

Installed extensions are enabled unless excluded. Codemode is enabled explicitly. Worker-side MCP and pi-subagents are excluded by default. UI-dependent extensions do not get an interactive Pi terminal. Inspect reported load errors if a plugin cannot work headlessly.

Agent instructions replace the parent role, and turns are unlimited. Legacy `prompt_mode: replace` and `max_turns: 0` fields can be accepted; other agent settings are not silently inherited from pi-subagents.

## MCP client setup

Use a Streamable HTTP server entry. For Claude Code:

```sh
claude mcp add --transport http --scope user pi-workers http://127.0.0.1:8787/mcp
```

For Pi, add a server to the Pi MCP configuration:

```json
{
  "mcpServers": {
    "pi-workers": {
      "url": "http://127.0.0.1:8787/mcp",
      "exposure": "direct",
      "timeout": 600
    }
  }
}
```

Other clients may require `"type": "http"` or `"type": "streamable-http"`. Configure client request timeouts for long waiting calls. The service does not modify your client configuration.

## Tools

| Tool | Action |
| --- | --- |
| `list_agents` | Read definitions, models, and thinking levels |
| `spawn_subagents` | Queue one or several tasks and return IDs immediately |
| `list_subagents` | Read worker states, activity, turns, usage, and context |
| `inspect_subagent` | Read a worker and paginated transcript events |
| `send_subagent` | Steer active work or submit another task to an idle worker |
| `configure_subagent` | Set thinking for subsequent requests |
| `stop_subagents` | Cancel selected work while retaining workers |
| `wait_subagents` | Wait for any or all selected tasks to finish |
| `get_subagent_results` | Fetch available results immediately |
| `release_subagents` | Dispose selected workers and free session resources |

Example spawn arguments:

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

Example wait arguments:

```json
{
  "ids": ["worker-id"],
  "type": "all",
  "timeoutSeconds": 300
}
```

With one ID, `any` and `all` have the same effect. With several IDs, `any` returns once at least one selected task is terminal. Already finished tasks return immediately. Use the remaining IDs for the next wait. Stopped and failed tasks count as finished, with their actual status.

Waiting is driven by service events, not polling. Cancelling or timing out a wait does not stop workers. There is no client-independent automatic parent wake-up: a caller receives results through waiting or retrieval tools. Terminal updates do not consume model tokens.

## Worker lifetime

Ten tasks can start or run at once by default. More tasks wait in a queue. Idle workers retain their conversation until released. A stopped worker retains partial output and can receive another task. A new task uses a new generation number so results from an earlier task do not masquerade as current results.

`stop_subagents` cancels work without undoing edits. `release_subagents` rejects active workers unless `force: true` is supplied. Releasing frees the SDK session; transcripts remain on disk. Workers do not survive service restart. Transcript files can contain sensitive task content and tool output; manage their retention yourself.

Workers share the working directory. There are no automatic file locks or Git worktrees. Divide write tasks by file ownership to avoid conflicts.

Token usage reports input, output, cache reads, and cache writes separately. Context usage is an estimate when Pi supplies it, not a count of all lifetime tokens. Supported thinking levels depend on model metadata.

## Development

```sh
bun run check
bun run test
```

Tests use fake worker sessions and local MCP clients. They do not require paid model calls.

To check your installed FFF, hashline edit, TinyFish, and codemode extensions against two concurrent worker sessions:

```sh
node scripts/smoke-installed-plugins.mjs
```

This optional check uses your global service configuration and installed extensions. It runs a local mock model server, searches and edits temporary files, and removes them afterward. It does not call paid model or search APIs. It is separate from the portable test suite because it requires those installed plugins.

### Memory check

On Linux, measure RSS, PSS, JavaScript heap, and buffers while running real SDK sessions with the installed plugins and a local mock model:

```sh
bun run build
node --expose-gc scripts/measure-memory.mjs /tmp/pi-subagents-memory.json
```

The check runs batches of 1, 10, 20, 10, and 10 tasks, with a concurrency limit of 10. Each task searches, reads, edits, uses codemode, and returns approximately 64 KiB of mock output. It samples memory every 100 ms and records memory after completion, release, and test-only forced garbage collection. The process includes the mock HTTP provider. It uses small temporary workspaces; large repositories and long real conversations can use more memory.
