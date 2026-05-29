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
