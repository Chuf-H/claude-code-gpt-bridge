# Claude Code GPT Bridge

Run Claude Code on GPT / OpenAI-compatible APIs while preserving the part that matters most: tool calling.

## Overview

Claude Code is useful because it is more than a chat window. It can act like a coding agent: read files, edit code, run shell commands, and call MCP tools. Many GPT / OpenAI-compatible endpoints can handle normal conversations, but fail or behave inconsistently when Claude Code expects Anthropic-style `tool_use / tool_result` messages.

This project provides a local Anthropic-compatible bridge. Claude Code still sends requests as usual; the bridge forwards them to a GPT / OpenAI-compatible API, injects a strict tool-call protocol, then parses GPT-produced `<tool_call>{...}</tool_call>` text back into executable Claude Code `tool_use` blocks.

The scope is intentionally focused: make Claude Code + GPT-compatible backends work as a real tool-using agent. Built-in tools and MCP tools have both been validated locally.

## The Problem

The common failure mode looks like this:

```text
Claude Code expects Anthropic tool_use / tool_result
GPT endpoints often emit text tool calls, or do not reliably emit standard tool_calls
```

When that protocol breaks, Claude Code degrades from a working coding agent into a model that can only talk. This bridge fills the missing protocol layer:

```text
Claude Code
-> local Anthropic-compatible bridge
-> GPT / OpenAI-compatible API
-> text <tool_call>{...}</tool_call>
-> bridge parses the tool call
-> Claude Code executes real tools
-> tool_result returns to GPT
```

The result is not just "GPT inside Claude Code"; it is GPT-backed Claude Code with working file access, edits, shell commands, and MCP calls.

## Current Status

Validated locally:

- multi-turn `Bash / Read / Write / Edit` tool calls;
- file creation, reading, editing, shell computation, and final verification;
- MCP tool calls using names like `mcp__server__tool`;
- `gpt-5.5` and `gpt-5.4` paths.

See [docs/VALIDATION.md](docs/VALIDATION.md) for a concise validation summary.

## Requirements

You need:

- Claude Code CLI;
- Node.js 18+;
- a GPT / OpenAI-compatible API endpoint.

Check Claude Code:

```sh
claude --version
```

## Quick Start

Create a private local config file. `.local/` is ignored by Git.

```sh
mkdir -p .local
cp settingapi.example.md .local/settingapi.md
```

Edit `.local/settingapi.md`:

```text
api = "sk-your-api-key-here"
base_url = "https://your-openai-compatible-endpoint.example/v1"
```

Run a minimal tool-call test:

```sh
./bin/claude-gpt -p --bare --no-session-persistence \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions \
  --allowedTools Bash \
  --model gpt-5.5 \
  "Use Bash to print pwd, then answer with the result."
```

If the output is the current directory, Claude Code is reaching your GPT API through the bridge and successfully executing a tool.

## Use It From Any Project

Add the wrapper to your PATH:

```sh
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/bin/claude-gpt" "$HOME/.local/bin/claude-gpt"
```

Then run it from any project:

```sh
cd /path/to/your/project
claude-gpt --model gpt-5.5
```

For trusted local projects, you can reduce permission prompts:

```sh
claude-gpt \
  --model gpt-5.5 \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions
```

## Environment Variable Setup

If you prefer not to use a config file:

```sh
export CLAUDE_GPT_API_KEY="sk-your-api-key-here"
export CLAUDE_GPT_BASE_URL="https://your-openai-compatible-endpoint.example/v1"

./bin/claude-gpt --model gpt-5.5
```

## MCP Tools

MCP tools are external tools exposed to Claude Code through the Model Context Protocol. Examples include GitHub, databases, browsers, internal APIs, and other custom services. In Claude Code, they usually appear with names like:

```text
mcp__server-name__tool-name
```

The bridge can parse GPT output like:

```text
<tool_call>{"name":"mcp__mini-calc__sum_numbers","arguments":{"numbers":[9,10,23]}}</tool_call>
```

and convert it into a Claude Code MCP tool call. This repository includes a tiny MCP example:

- [examples/mini-mcp-server.mjs](examples/mini-mcp-server.mjs)
- [examples/mcp-config.example.json](examples/mcp-config.example.json)

## Project Layout

```text
bin/                         wrapper and bridge scripts
src/claude-gpt-bridge.mjs    bridge implementation
prompts/                     injected GPT tool protocol prompt
examples/                    MCP example
docs/VALIDATION.md           validation summary
test/bridge-unit.mjs         parser and conversion unit tests
settingapi.example.md        private API config template
```

## Safety

This project is set up so your API key is not committed by default:

- `.local/` is ignored;
- `settingapi.md` and `settingapi.local.md` are ignored;
- traces, logs, and temporary test directories are ignored.

Before publishing or sharing changes, run:

```sh
./scripts/check-public-safe.sh
```

It scans for common API keys, local home paths, and Claude/GitHub session traces.

## Tests

```sh
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

## Notes

This is a local bridge project, not an official Anthropic or OpenAI project. Its goal is deliberately narrow: keep Claude Code's tool protocol usable when the backend is a GPT / OpenAI-compatible API.

Different endpoints, models, and MCP servers may still have edge cases. Issues, tests, and adaptation notes are welcome.
