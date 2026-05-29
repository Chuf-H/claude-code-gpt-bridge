# Validation Summary

This bridge was validated locally with Claude Code CLI and a GPT-compatible API endpoint.

## Built-In Tools

Validated tool flow:

```text
GPT text <tool_call>
-> bridge parser
-> Anthropic tool_use
-> Claude Code tool execution
-> tool_result
-> next GPT turn
```

Covered built-in Claude Code tools:

- `Bash`
- `Read`
- `Write`
- `Edit`

The validation tasks created files, read them back, edited content, ran a shell command, and completed with the expected final answer.

## Long-Loop Tool Availability Guardrail

Autonomous research loops can contain enough prior context that a GPT-compatible backend may forget the bridge protocol and answer as if file or shell tools do not exist. The bridge now adds a compact tool reminder to the latest user turn and performs one corrective retry when all of the following are true:

- Claude Code provided file or shell tools such as `Bash`, `Read`, `Write`, or `Edit`;
- the backend returned normal text rather than a parsed tool call;
- the text claims file, shell, command, terminal, or tool access is unavailable.

This path is covered by unit tests and by a local mock end-to-end test that forces the first upstream response to deny tool access, then verifies that the retry returns a Claude Code `tool_use` block.

## GPT Output Variants

Some GPT-compatible backends do not consistently follow the preferred `<tool_call>{...}</tool_call>` protocol. The parser now also accepts:

- Anthropic-style self-closing text tags: `<tool_use name="Read" input="{...}"></tool_use>` and `<tool_use id="..." name="Read" input={...} />`;
- Anthropic-style JSON bodies: `<tool_use>{"tool_name":"Read","parameters":{...}}</tool_use>`;
- complete JSON tool calls where the model emitted `<tool_call>{...}` but forgot the closing `</tool_call>` tag.

These variants are covered by unit tests and were exercised in remote Claude Code probes where the GPT backend alternated between several formats.

## Autoresearch-Shaped Probe

A scratch two-round autoresearch loop was validated with the bridge. Each round read status and queue files, ran a Bash aggregation over a local CSV, and updated continuation plan, summary, journal, and queue files through Claude Code tools. The successful rounds used `Read`, `Glob`, `Bash`, and repeated `Edit` calls without falling back to "tools unavailable" text.

The wrapper also generates runtime Claude settings for the selected bridge host and port. This prevents user-level Claude Code settings from silently routing requests to a different local endpoint.

## MCP Tools

MCP tools were validated with a local stdio MCP fixture that exposed:

```text
mcp__mini-calc__sum_numbers
```

The model emitted:

```text
<tool_call>{"name":"mcp__mini-calc__sum_numbers","arguments":{"numbers":[9,10,23]}}</tool_call>
```

The bridge converted it to Claude Code `tool_use`, Claude Code called the MCP server, and the tool result returned:

```text
MCP_SUM=42
```

## Privacy

Raw trace logs are intentionally not committed. They can contain local paths, session identifiers, prompts, and tool schemas.
