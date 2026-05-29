# Issue and Fix Report

This note explains the main reliability issue this bridge was built and hardened to solve.

## What Failed

Small smoke tests worked: Claude Code could ask the GPT-compatible backend to write a file or run a simple shell command, and the bridge could convert the model's text tool request into a real Claude Code `tool_use`.

The failure appeared in longer agent loops. In an autoresearch-style loop, the backend sometimes stopped using tools and answered as if no file or shell tools existed:

```text
I cannot continue because file or shell tools are not available in this session.
```

That is a serious failure mode for Claude Code. Once the model says this instead of emitting a tool call, Claude Code has nothing to execute. The loop silently degrades from "agent that can inspect and edit the project" into "chat model that explains why it cannot work."

## Why It Happened

There were three overlapping causes.

First, the original prompt put the tool protocol in the system message, but long loops add many turns of project state, tool results, plans, and logs. The model could lose the immediate instruction that host tools were available through the bridge.

Second, GPT-compatible backends do not always emit one stable tool syntax. During testing, the backend produced several variants:

```text
<tool_call>{"name":"Bash","arguments":{...}}</tool_call>
<tool_use name="Read" input={...} />
<tool_use>{"tool_name":"Read","parameters":{...}}</tool_use>
<tool_call>{"name":"Bash","arguments":{...}
```

The last example is a complete JSON tool request with a missing closing XML tag. A strict parser treats that as plain text, so Claude Code never sees a real `tool_use`.

Third, Claude Code user settings can override environment variables. If global settings point to another local endpoint, a wrapper may look correct while Claude Code is actually sending requests somewhere else. That makes debugging especially confusing: the displayed model can look right, while the bridge under test is not the bridge being called.

## What Changed

The bridge now adds a compact tool reminder to the latest user turn whenever Claude Code provides tools. This keeps the important instruction close to the current decision point:

```text
Host tools ARE AVAILABLE in this Claude Code session: Bash, Read, Write, Edit...
If the task requires files or shell commands, emit <tool_call>{...}</tool_call>.
```

It also detects a false "tools unavailable" answer. If Claude Code provided file or shell tools, the backend returned plain text, and that text claims tools are unavailable, the bridge retries once with a corrective message. This is intentionally narrow so normal answers are not disturbed.

The parser was expanded to accept the tool-call variants observed in real runs:

- preferred bridge syntax: `<tool_call>{...}</tool_call>`;
- self-closing or paired Anthropic-style text tags: `<tool_use name="Read" input={...} />`;
- JSON bodies inside `<tool_use>...</tool_use>`;
- complete JSON tool calls with a missing `</tool_call>` closing tag;
- common argument aliases such as `cmd` -> `command` and `path` -> `file_path`.

The wrapper now generates a runtime Claude settings file with the selected bridge host and port. This prevents user-level Claude Code settings from silently routing requests away from the bridge.

Finally, transient upstream failures such as 502/503/504 provider availability errors can fall back from the primary GPT model to the configured fallback model.

## How It Was Checked

The fix was checked at several levels:

- unit tests for JSON parsing, tool input repair, denial detection, fallback decisions, and all observed tool-call syntaxes;
- a mock end-to-end test where the first upstream response falsely denies tools and the retry returns a real tool call;
- a real Claude Code probe that executed `Read` and `Write` through the bridge;
- a more complex probe that executed `Read`, `Write`, `Bash`, and `Edit`, created a report, ran a verifier, and appended `Verification: PASS`;
- a scratch autoresearch-shaped two-round loop that read status files, ran a shell aggregation, and updated plan, summary, journal, and queue files through Claude Code tools.

The important result is not just that a one-line tool smoke test works. The bridge now survives a longer loop where the model has to keep reading state, running commands, editing files, and continuing after tool results.

## Remaining Scope

This is still a local compatibility bridge, not an official API implementation. Different GPT-compatible gateways may introduce new output quirks, and MCP servers can have their own schemas. The bridge is deliberately small and testable so new variants can be added without changing the Claude Code side of the workflow.
