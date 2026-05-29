# Repository Intro Draft

## GitHub Description

Bridge Claude Code to GPT/OpenAI-compatible APIs with reliable built-in and MCP tool calling.

## Share Text

### 1. 我们发现的问题

Claude Code 的价值不只是“模型回答”，而是它能像 agent 一样读文件、改代码、跑命令、调用 MCP 工具。很多 GPT / OpenAI-compatible endpoint 可以正常聊天，但一进入 Claude Code 的工具调用流程，就会遇到协议不匹配：Claude Code 期待 Anthropic 的 `tool_use / tool_result`，而 GPT endpoint 往往返回文本化工具调用，或者并不稳定地产生标准 `tool_calls`。

这个问题很关键，因为一旦工具协议断掉，Claude Code 就会从“能工作的 coding agent”退化成“只能聊天的模型窗口”。修好这层协议，才有机会把 Claude Code 的工程体验接到更多模型后端上。

### 2. 我们做了什么

这个项目实现了一个本地 Anthropic-compatible bridge：Claude Code 仍然按原方式发 `/v1/messages` 请求，bridge 会把请求转给 GPT / OpenAI-compatible API，并注入一套明确的工具调用协议；当 GPT 返回 `<tool_call>{...}</tool_call>` 这类文本工具调用时，bridge 会解析并转换成 Claude Code 可以执行的 `tool_use`。

目前已经本地验证了多轮工具链路：`Bash / Read / Write / Edit` 可以正常执行，MCP 工具也能以 `mcp__server__tool` 的形式调用。效果上，它不只是“能问答”，而是可以继续完成文件读写、代码修改、命令执行和外部工具调用这些 agent 工作流。

### 3. 期待交流

这个项目还很小，目标也很聚焦：先把 Claude Code + GPT-compatible backend 的工具协议打通。不同 endpoint、不同模型、不同 MCP server 的表现可能还会有细节差异，欢迎大家试用、提 issue、补充适配经验，或者一起把它打磨成更稳的 Claude Code 替代后端方案。
