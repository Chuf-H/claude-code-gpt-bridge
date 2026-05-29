# Claude Code GPT Bridge

让 Claude Code 跑在 GPT / OpenAI-compatible API 上，并且保住最关键的能力：工具调用。

## 项目简介

Claude Code 的价值不只是“模型回答”，而是它能像 agent 一样读文件、改代码、跑命令、调用 MCP 工具。很多 GPT / OpenAI-compatible endpoint 可以正常聊天，但在 Claude Code 的工具调用流程里会遇到协议不匹配：Claude Code 期待 Anthropic 的 `tool_use / tool_result`，而 GPT endpoint 往往返回文本化工具调用，或者并不稳定地产生标准 `tool_calls`。

这个项目实现了一个本地 Anthropic-compatible bridge：Claude Code 仍然按原方式发请求，bridge 负责转发到 GPT / OpenAI-compatible API，并把 GPT 生成的 `<tool_call>{...}</tool_call>` 解析回 Claude Code 可执行的 `tool_use`。目前已验证 `Bash / Read / Write / Edit` 多轮工具链路，也验证了 `mcp__server__tool` 形式的 MCP 工具调用。

项目还很小，目标也很聚焦：先把 Claude Code + GPT-compatible backend 的工具协议打通。不同 endpoint、模型和 MCP server 可能仍有差异，欢迎大家试用、提 issue、分享适配经验。

## 解决什么问题

很多 OpenAI-compatible endpoint 可以正常聊天，但在 Claude Code 场景里会卡在工具协议上：

```text
Claude Code 期待 Anthropic tool_use / tool_result
GPT endpoint 倾向返回文本化工具调用，或不稳定返回 tool_calls
```

这个 bridge 在中间补齐协议：

```text
Claude Code
-> local Anthropic-compatible bridge
-> GPT / OpenAI-compatible API
-> text <tool_call>{...}</tool_call>
-> bridge parses tool call
-> Claude Code executes real tools
-> tool_result returns to GPT
```

也就是说，不只是能问答，而是能继续像 agent 一样读文件、改代码、跑命令、调用 MCP。

## 状态

已本地验证：

- `Bash / Read / Write / Edit` 多轮工具调用
- 文件创建、读取、编辑、shell 计算、最终复核
- MCP 工具调用，形如 `mcp__server__tool`
- `gpt-5.5` 与 `gpt-5.4` 路径

更详细的验证摘要见 [docs/VALIDATION.md](docs/VALIDATION.md)。

## 安装前提

你需要本机已经能运行：

- Claude Code CLI
- Node.js 18+
- 一个 GPT / OpenAI-compatible API endpoint

检查 Claude Code：

```sh
claude --version
```

## 三分钟开始

复制私有配置文件。`.local/` 已经在 `.gitignore` 里，不会被提交。

```sh
mkdir -p .local
cp settingapi.example.md .local/settingapi.md
```

编辑 `.local/settingapi.md`：

```text
api = "sk-your-api-key-here"
base_url = "https://your-openai-compatible-endpoint.example/v1"
```

跑一个最小测试：

```sh
./bin/claude-gpt -p --bare --no-session-persistence \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions \
  --allowedTools Bash \
  --model gpt-5.5 \
  "Use Bash to print pwd, then answer with the result."
```

如果输出了当前目录，说明 Claude Code 已经通过 bridge 调到了 GPT API，并成功执行了工具。

## 在任意项目里使用

推荐把 wrapper 链接到 PATH：

```sh
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/bin/claude-gpt" "$HOME/.local/bin/claude-gpt"
```

之后在任何项目目录：

```sh
cd /path/to/your/project
claude-gpt --model gpt-5.5
```

如果是你信任的项目，可以减少工具确认：

```sh
claude-gpt \
  --model gpt-5.5 \
  --permission-mode bypassPermissions \
  --dangerously-skip-permissions
```

## 不想写配置文件

也可以直接用环境变量：

```sh
export CLAUDE_GPT_API_KEY="sk-your-api-key-here"
export CLAUDE_GPT_BASE_URL="https://your-openai-compatible-endpoint.example/v1"

./bin/claude-gpt --model gpt-5.5
```

## MCP 工具

MCP 工具是 Claude Code 通过 Model Context Protocol 接入的外部工具，比如 GitHub、数据库、浏览器、公司内部系统等。进入 Claude Code 后，工具名通常长这样：

```text
mcp__server-name__tool-name
```

这个 bridge 会把 GPT 生成的：

```text
<tool_call>{"name":"mcp__mini-calc__sum_numbers","arguments":{"numbers":[9,10,23]}}</tool_call>
```

解析成 Claude Code 的 MCP 工具调用。仓库里带了一个最小 MCP 示例：

- [examples/mini-mcp-server.mjs](examples/mini-mcp-server.mjs)
- [examples/mcp-config.example.json](examples/mcp-config.example.json)

## 文件结构

```text
bin/                         wrapper 和 bridge 启停脚本
src/claude-gpt-bridge.mjs    协议桥主体
prompts/                     注入给 GPT 的工具协议 prompt
examples/                    MCP 示例
docs/VALIDATION.md           验证摘要
test/bridge-unit.mjs         解析与转换单元测试
settingapi.example.md        私有 API 配置模板
```

## 安全

这个项目默认不会提交你的 API key：

- `.local/` 被 `.gitignore` 忽略
- `settingapi.md` 和 `settingapi.local.md` 被忽略
- trace、日志、临时测试目录被忽略

发布前建议跑：

```sh
./scripts/check-public-safe.sh
```

它会扫描常见 API key、本机路径、Claude/GitHub 会话痕迹等。

## 测试

```sh
node test/bridge-unit.mjs
./scripts/check-public-safe.sh
```

## 说明

这是一个本地桥接项目，不是 Anthropic 或 OpenAI 官方项目。它的目标很窄：让 Claude Code 在 GPT / OpenAI-compatible backend 上继续拥有可用的工具调用协议。
