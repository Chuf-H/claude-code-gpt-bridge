#!/usr/bin/env node

import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const HOST = process.env.CLAUDE_GPT_BRIDGE_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.CLAUDE_GPT_BRIDGE_PORT || "8822", 10);
const SETTINGS_CANDIDATES = [
  process.env.CLAUDE_GPT_API_FILE,
  path.join(ROOT, ".local", "settingapi.md"),
  path.join(ROOT, "settingapi.local.md"),
  path.join(ROOT, "settingapi.md"),
].filter(Boolean);
const DEFAULT_MODEL = process.env.CLAUDE_GPT_MODEL || "gpt-5.5";
const FALLBACK_MODEL = process.env.CLAUDE_GPT_FALLBACK_MODEL || "gpt-5.4";
const UPSTREAM_TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_GPT_TIMEOUT_MS || "180000", 10);
const UPSTREAM_RETRIES = Number.parseInt(process.env.CLAUDE_GPT_UPSTREAM_RETRIES || "2", 10);
const UPSTREAM_RETRY_BASE_MS = Number.parseInt(process.env.CLAUDE_GPT_UPSTREAM_RETRY_BASE_MS || "750", 10);
const TOOL_COMPLIANCE_RETRIES = Math.max(1, Number.parseInt(process.env.CLAUDE_GPT_TOOL_COMPLIANCE_RETRIES || "3", 10));
const TRACE = process.env.CLAUDE_GPT_BRIDGE_TRACE === "1";
const TRACE_FILE = process.env.CLAUDE_GPT_TRACE_FILE || path.join(ROOT, ".bridge", "trace.ndjson");
const PRIVATE_HOME_RE = new RegExp(`/${"Users"}/[^/\\s"]+`, "g");
const REDACTED_HOME = ["", "Users", "<user>"].join("/");
const PRIVATE_METADATA_KEYS = ["device_id", "account_uuid", "session_id"];

let upstreamConfigPromise;

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function anthropicError(status, type, message) {
  return {
    type: "error",
    error: {
      type,
      message,
    },
  };
}

async function trace(event, data) {
  if (!TRACE) {
    return;
  }
  await fs.mkdir(path.dirname(TRACE_FILE), { recursive: true });
  const redacted = JSON.stringify(data, (key, value) => {
    if (typeof value === "string" && /sk-[A-Za-z0-9_-]{12,}/.test(value)) {
      return value.replace(/(sk-[A-Za-z0-9_-]{12})[A-Za-z0-9_-]+/g, "$1...REDACTED");
    }
    if (typeof value === "string") {
      let out = value.replace(PRIVATE_HOME_RE, REDACTED_HOME);
      for (const metadataKey of PRIVATE_METADATA_KEYS) {
        out = out.replace(new RegExp(`"${metadataKey}"\\s*:\\s*"[^"]*"`, "g"), `"${metadataKey}":"...REDACTED"`);
      }
      return out;
    }
    if (key.toLowerCase() === "authorization") {
      return "Bearer ...REDACTED";
    }
    if ([...PRIVATE_METADATA_KEYS, "uuid", "user_id"].includes(key)) {
      return "...REDACTED";
    }
    return value;
  });
  await fs.appendFile(TRACE_FILE, JSON.stringify({ ts: new Date().toISOString(), event, data: JSON.parse(redacted) }) + "\n");
}

async function readUpstreamConfig() {
  if (upstreamConfigPromise) {
    return upstreamConfigPromise;
  }
  upstreamConfigPromise = (async () => {
    const settings = await readFirstConfig();
    const text = settings.text;
    const apiKey = process.env.CLAUDE_GPT_API_KEY || matchRequired(text, /api\s*=\s*"([^"]+)"/, "api");
    const baseUrl = (process.env.CLAUDE_GPT_BASE_URL || matchRequired(text, /base_url\s*=\s*"([^"]+)"/, "base_url")).replace(/\/$/, "");
    return { apiKey, baseUrl };
  })();
  return upstreamConfigPromise;
}

async function readFirstConfig() {
  const errors = [];
  for (const candidate of SETTINGS_CANDIDATES) {
    try {
      return { path: candidate, text: await fs.readFile(candidate, "utf8") };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        errors.push(`${candidate}: ${error.message}`);
      }
    }
  }
  const searched = SETTINGS_CANDIDATES.map((candidate) => `- ${candidate}`).join("\n");
  throw new Error(`Missing GPT API config. Create .local/settingapi.md from settingapi.example.md, set CLAUDE_GPT_API_FILE, or export CLAUDE_GPT_API_KEY and CLAUDE_GPT_BASE_URL.\nSearched:\n${searched}${errors.length ? `\nErrors:\n${errors.join("\n")}` : ""}`);
}

function matchRequired(text, regexp, name) {
  const match = text.match(regexp);
  if (!match) {
    throw new Error(`Missing ${name} in GPT API config`);
  }
  return match[1];
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function textFromBlock(block) {
  if (!block) {
    return "";
  }
  if (typeof block === "string") {
    return block;
  }
  if (block.type === "text") {
    return block.text || "";
  }
  if (block.type === "thinking") {
    return block.thinking ? `<thinking>${block.thinking}</thinking>` : "";
  }
  if (block.type === "tool_result") {
    return toolResultToString(block.content);
  }
  if (block.type === "image") {
    return "[image content omitted by bridge]";
  }
  if (block.type === "document") {
    return "[document content omitted by bridge]";
  }
  return "";
}

function toolResultToString(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(textFromBlock).filter(Boolean).join("\n");
  }
  if (content == null) {
    return "";
  }
  return JSON.stringify(content);
}

function collectSystemText(systemBlocks) {
  if (!systemBlocks) {
    return "";
  }
  if (typeof systemBlocks === "string") {
    return systemBlocks;
  }
  if (Array.isArray(systemBlocks)) {
    return systemBlocks.map(textFromBlock).filter(Boolean).join("\n\n");
  }
  return textFromBlock(systemBlocks);
}

function formatPriorToolUse(block) {
  return `<tool_call>${JSON.stringify({
    id: block.id,
    name: block.name,
    arguments: block.input || {},
  })}</tool_call>`;
}

function flattenAnthropicMessages(systemBlocks = [], messages = [], tools = []) {
  const result = [];
  const systemText = collectSystemText(systemBlocks);
  const bridgePrompt = buildToolProtocolPrompt(tools);
  result.push({
    role: "system",
    content: [systemText, bridgePrompt].filter(Boolean).join("\n\n"),
  });

  for (const message of messages || []) {
    if (!message) {
      continue;
    }
    const content = Array.isArray(message.content) ? message.content : [message.content];

    if (message.role === "assistant") {
      const parts = [];
      for (const block of content) {
        if (block?.type === "text") {
          if (block.text) {
            parts.push(block.text);
          }
          continue;
        }
        if (block?.type === "thinking") {
          if (block.thinking) {
            parts.push(`<thinking>${block.thinking}</thinking>`);
          }
          continue;
        }
        if (block?.type === "tool_use") {
          parts.push(formatPriorToolUse(block));
        }
      }
      result.push({ role: "assistant", content: parts.join("\n\n") || "[assistant message]" });
      continue;
    }

    if (message.role === "user") {
      const parts = [];
      for (const block of content) {
        if (block?.type === "text") {
          if (block.text) {
            parts.push(block.text);
          }
          continue;
        }
        if (block?.type === "tool_result") {
          parts.push(`<tool_result id="${escapeXmlAttr(block.tool_use_id || "")}" is_error="${block.is_error ? "true" : "false"}">\n${toolResultToString(block.content)}\n</tool_result>`);
        }
      }
      result.push({ role: "user", content: parts.join("\n\n") || "[user message]" });
    }
  }

  appendLatestToolReminder(result, tools);
  return result;
}

function escapeXmlAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function summarizeTool(tool) {
  return {
    name: tool.name,
    description: truncate(tool.description || "", 1800),
    input_schema: tool.input_schema || {
      type: "object",
      additionalProperties: true,
    },
  };
}

function truncate(value, max) {
  if (typeof value !== "string" || value.length <= max) {
    return value;
  }
  return value.slice(0, max - 20) + "\n...[truncated]";
}

function buildToolProtocolPrompt(tools = []) {
  const toolSummaries = tools.map(summarizeTool);
  const toolBlock = JSON.stringify(toolSummaries, null, 2);
  const names = toolNames(tools);
  return [
    "## Claude Code GPT Tool Bridge",
    "",
    "You are the model backend for Claude Code. You do not have direct filesystem, shell, network, or editor access. When you need to inspect files, run commands, or edit files, you must request one of the host tools below. The bridge will convert your request into Claude Code tool_use blocks, Claude Code will execute the tool, and you will receive a <tool_result> message.",
    "",
    names.length ? `Available tool names now: ${names.join(", ")}` : "Available tool names now: none.",
    "",
    "Tool-call protocol:",
    "- If a tool is needed, output only one or more tool call tags and no explanatory prose.",
    "- Exact format: <tool_call>{\"name\":\"ToolName\",\"arguments\":{...}}</tool_call>",
    "- Tool names are case-sensitive. The arguments object must match the selected tool's input_schema.",
    "- Multiple independent tool calls may be emitted as multiple adjacent <tool_call>...</tool_call> tags.",
    "- Do not wrap tool calls in Markdown fences. Do not invent tool results. After receiving tool results, continue with another tool call or a normal final answer.",
    "- For Bash, use the key \"command\" for the shell command and include a short \"description\" when possible.",
    "- For Read, Write, Edit, MultiEdit, Grep, Glob, and LS, use the exact field names shown in their schemas.",
    "- If Bash, Read, Write, Edit, Grep, Glob, LS, or mcp__... tools are listed above, never claim that file, shell, filesystem, or MCP tools are unavailable. Request the tool instead.",
    "- If no tool is needed, answer normally without any <tool_call> tags.",
    "",
    "Available tools:",
    "```json",
    toolBlock,
    "```",
  ].join("\n");
}

function toolNames(tools = []) {
  return (tools || []).map((tool) => tool?.name).filter(Boolean);
}

function hasFileOrShellTools(tools = []) {
  const names = new Set(toolNames(tools));
  return ["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob", "LS"].some((name) => names.has(name));
}

function buildLatestToolReminder(tools = []) {
  const names = toolNames(tools);
  if (!names.length) {
    return "";
  }

  const examples = [];
  if (names.includes("Bash")) {
    examples.push("<tool_call>{\"name\":\"Bash\",\"arguments\":{\"command\":\"pwd\",\"description\":\"Print current directory\"}}</tool_call>");
  }
  if (names.includes("Read")) {
    examples.push("<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"/absolute/path/to/file\"}}</tool_call>");
  }
  const mcpName = names.find((name) => name.startsWith("mcp__"));
  if (mcpName) {
    examples.push(`<tool_call>{"name":"${mcpName}","arguments":{}}</tool_call>`);
  }

  return [
    "<bridge_tool_reminder>",
    `Host tools ARE AVAILABLE in this Claude Code session: ${names.join(", ")}.`,
    "If the task requires files, shell commands, edits, search, or MCP, emit <tool_call>{...}</tool_call> rather than saying you lack tools.",
    hasFileOrShellTools(tools) ? "Bash/Read/Write/Edit-style tools mean file and shell work is possible through the host. Do not claim otherwise." : "",
    examples.length ? `Examples: ${examples.join(" ")}` : "",
    "</bridge_tool_reminder>",
  ].filter(Boolean).join("\n");
}

function appendLatestToolReminder(messages, tools = []) {
  const reminder = buildLatestToolReminder(tools);
  if (!reminder) {
    return;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      messages[index] = {
        ...messages[index],
        content: `${messages[index].content || ""}\n\n${reminder}`,
      };
      return;
    }
  }

  messages.push({ role: "user", content: reminder });
}

function modelForRequest(model) {
  if (process.env.CLAUDE_GPT_FORCE_MODEL === "1") {
    return DEFAULT_MODEL;
  }
  if (typeof model === "string" && /^(gpt-|codex-|deepseek-|qwen|kimi|glm|mimo)/i.test(model)) {
    return model;
  }
  return DEFAULT_MODEL;
}

function toOpenAIChatRequest(body) {
  const request = {
    model: modelForRequest(body.model),
    messages: flattenAnthropicMessages(body.system, body.messages, body.tools),
    stream: false,
    max_tokens: body.max_tokens || 4096,
  };
  if (typeof body.temperature === "number") {
    request.temperature = body.temperature;
  }
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    request.stop = body.stop_sequences;
  }
  return request;
}

async function callUpstreamChat(body, modelOverride = null) {
  const { apiKey, baseUrl } = await readUpstreamConfig();
  const payload = modelOverride ? { ...body, model: modelOverride } : body;
  const attempts = Math.max(0, UPSTREAM_RETRIES) + 1;
  let lastResult = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      await trace("upstream_request", { attempt, attempts, payload });
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      const result = {
        ok: response.ok,
        status: response.status,
        payload: parsed,
        raw: text,
        model: payload.model,
        attempt,
        attempts,
      };
      await trace("upstream_response", { status: response.status, ok: response.ok, attempt, attempts, payload: parsed });
      lastResult = result;
      if (!response.ok && attempt < attempts && isRetryableUpstreamStatus(response.status, parsed)) {
        await trace("upstream_retry", { attempt, status: response.status, model: payload.model });
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return result;
    } catch (error) {
      const result = upstreamFetchErrorResult(error, payload.model, attempt, attempts);
      lastResult = result;
      await trace("upstream_fetch_error", {
        attempt,
        attempts,
        model: payload.model,
        status: result.status,
        message: result.payload.error.message,
      });
      if (attempt < attempts && isRetryableFetchError(error)) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  return lastResult || upstreamFetchErrorResult(new Error("upstream request failed before execution"), payload.model, attempts, attempts);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt) {
  return Math.min(5000, UPSTREAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function isRetryableUpstreamStatus(status, payload = {}) {
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const message = upstreamErrorMessage({ payload });
  return /timeout|timed out|temporar|overload|rate|gateway|fetch failed|connection|reset|socket/i.test(message);
}

function isRetryableFetchError(error) {
  const message = `${error?.name || ""} ${error?.code || ""} ${error?.message || ""} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`;
  return /AbortError|Timeout|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|terminated/i.test(message);
}

function upstreamFetchErrorResult(error, model, attempt, attempts) {
  const isTimeout = error?.name === "AbortError";
  const message = `${isTimeout ? "upstream_timeout" : "upstream_fetch_failed"} after ${attempt}/${attempts} attempt(s): ${error?.message || String(error)}`;
  return {
    ok: false,
    status: isTimeout ? 504 : 502,
    payload: {
      error: {
        type: isTimeout ? "upstream_timeout" : "upstream_fetch_error",
        message,
        code: error?.code || error?.cause?.code || undefined,
      },
    },
    raw: message,
    model,
    attempt,
    attempts,
  };
}

async function callUpstreamWithFallback(body, context = {}) {
  const tools = context.tools || [];
  const firstRaw = await callUpstreamChat(body);
  const first = firstRaw.ok ? await retryToolComplianceOnce(firstRaw, body, tools) : firstRaw;
  if (first.ok || body.model === FALLBACK_MODEL) {
    return first;
  }
  if (shouldFallbackToFallbackModel(first, body.model)) {
    const fallbackRaw = await callUpstreamChat(body, FALLBACK_MODEL);
    const fallback = fallbackRaw.ok ? await retryToolComplianceOnce(fallbackRaw, body, tools, FALLBACK_MODEL) : fallbackRaw;
    if (fallback.ok) {
      return fallback;
    }
  }
  return first;
}

function upstreamErrorMessage(upstream) {
  return String(
    upstream?.payload?.error?.message ||
      upstream?.payload?.detail ||
      upstream?.payload?.error ||
      upstream?.raw ||
      "",
  );
}

function shouldFallbackToFallbackModel(upstream, requestedModel) {
  if (requestedModel === FALLBACK_MODEL) {
    return false;
  }
  const message = upstreamErrorMessage(upstream);
  if (upstream?.status === 400 && /model|unsupported|not supported|Instructions are required/i.test(message)) {
    return true;
  }
  if ([500, 502, 503, 504].includes(upstream?.status) && /model|provider|key|available|temporar|overload|server|gateway|fetch failed|timeout|connection|reset|socket|network/i.test(message)) {
    return true;
  }
  return false;
}

async function retryToolComplianceOnce(upstream, body, tools = [], modelOverride = null) {
  let current = upstream;
  for (let attempt = 1; attempt <= TOOL_COMPLIANCE_RETRIES; attempt += 1) {
    const before = current;
    if (shouldRetryToolDenial(current, tools)) {
      current = await retryToolDenialOnce(current, body, tools, modelOverride, attempt);
    }
    if (shouldRetryPlanningOnly(current, tools)) {
      current = await retryPlanningOnlyOnce(current, body, tools, modelOverride, attempt);
    }
    if (current === before || (!shouldRetryToolDenial(current, tools) && !shouldRetryPlanningOnly(current, tools))) {
      break;
    }
  }
  if (shouldRetryPlanningOnly(current, tools) && isMalformedToolProtocolText(openAIMessageText(upstreamAssistantMessage(current)))) {
    return quarantineMalformedToolProtocol(current);
  }
  return current;
}

async function retryToolDenialOnce(upstream, body, tools = [], modelOverride = null, attempt = 1) {
  if (!shouldRetryToolDenial(upstream, tools)) {
    return upstream;
  }

  const retryBody = withToolDenialCorrection(body, tools, upstream);
  await trace("tool_denial_retry", {
    attempt,
    model: modelOverride || body?.model,
    available_tools: toolNames(tools),
    denial_preview: truncate(openAIMessageText(upstreamAssistantMessage(upstream)), 500),
  });
  const retry = await callUpstreamChat(retryBody, modelOverride);
  return retry.ok ? { ...retry, bridge_retry: "tool_denial" } : upstream;
}

async function retryPlanningOnlyOnce(upstream, body, tools = [], modelOverride = null, attempt = 1) {
  if (!shouldRetryPlanningOnly(upstream, tools)) {
    return upstream;
  }

  const retryBody = withPlanningOnlyCorrection(body, tools, upstream);
  await trace("planning_only_retry", {
    attempt,
    model: modelOverride || body?.model,
    available_tools: toolNames(tools),
    planning_preview: truncate(openAIMessageText(upstreamAssistantMessage(upstream)), 500),
  });
  const retry = await callUpstreamChat(retryBody, modelOverride);
  return retry.ok ? { ...retry, bridge_retry: "planning_only" } : upstream;
}

function quarantineMalformedToolProtocol(upstream) {
  const clone = JSON.parse(JSON.stringify(upstream));
  const message = clone?.payload?.choices?.[0]?.message;
  if (message) {
    delete message.tool_calls;
    message.content = "[bridge rejected malformed tool protocol after retry budget; no executable tool call was emitted]";
  }
  if (clone?.payload?.choices?.[0]) {
    clone.payload.choices[0].finish_reason = "stop";
  }
  return { ...clone, bridge_retry: "malformed_tool_protocol_quarantined" };
}

function shouldRetryToolDenial(upstream, tools = []) {
  if (!upstream?.ok || !hasFileOrShellTools(tools)) {
    return false;
  }

  const message = upstreamAssistantMessage(upstream);
  if (upstreamMessageHasToolCall(message, tools)) {
    return false;
  }
  return isToolDenialText(openAIMessageText(message));
}

function shouldRetryPlanningOnly(upstream, tools = []) {
  if (!upstream?.ok || !hasFileOrShellTools(tools)) {
    return false;
  }

  const message = upstreamAssistantMessage(upstream);
  if (upstreamMessageHasToolCall(message, tools)) {
    return false;
  }
  const text = openAIMessageText(message);
  return isMalformedToolProtocolText(text) || isPlanningOnlyText(text);
}

function upstreamAssistantMessage(upstream) {
  return upstream?.payload?.choices?.[0]?.message || {};
}

function upstreamMessageHasToolCall(message = {}, tools = []) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return true;
  }
  return extractToolCallsFromText(openAIMessageText(message), tools).length > 0;
}

function openAIMessageText(message = {}) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        return part?.text || "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function isToolDenialText(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const normalized = text.replace(/\s+/g, " ");
  const englishPatterns = [
    /\b(?:no|without|lack|lacking|don't have|do not have|can't access|cannot access|unable to access|don't have access to|do not have access to)\b.{0,140}\b(?:file|files|filesystem|shell|bash|terminal|command|commands|tool|tools|mcp)\b/i,
    /\b(?:file|files|filesystem|shell|bash|terminal|command|commands|tool|tools|mcp)\b.{0,140}\b(?:unavailable|not available|not accessible|can't access|cannot access|don't have|do not have|no access|lack|lacking)\b/i,
  ];
  const chinesePatterns = [
    /没有.{0,50}(工具|文件|文件系统|shell|终端|命令|bash|mcp)/i,
    /无法.{0,50}(访问|使用|调用).{0,50}(工具|文件|文件系统|shell|终端|命令|bash|mcp)/i,
    /不能.{0,50}(访问|使用|调用).{0,50}(工具|文件|文件系统|shell|终端|命令|bash|mcp)/i,
    /(工具|文件|文件系统|shell|终端|命令|bash|mcp).{0,50}(不可用|没有|无法访问|不能访问)/i,
  ];
  return [...englishPatterns, ...chinesePatterns].some((pattern) => pattern.test(normalized));
}

function isPlanningOnlyText(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 1800) {
    return false;
  }

  const startsLikePlan =
    /^(?:i(?:'|’)?ll|i will|i(?:'|’)?m going to|let me|i need to|i should|i can|next,? i(?:'|’)?ll)\b/i.test(normalized) ||
    /^(?:我会|我将|我先|接下来我|先看|先检查|先运行|先写|先创建)/.test(normalized);
  if (!startsLikePlan) {
    return false;
  }

  const hostWork =
    /\b(?:inspect|check|read|open|search|grep|list|run|execute|create|write|edit|update|modify|patch|test|verify|compile|generate|save)\b/i.test(normalized) ||
    /(?:检查|读取|查看|搜索|运行|执行|创建|写入|修改|更新|测试|验证|编译|生成|保存)/.test(normalized);
  if (!hostWork) {
    return false;
  }

  const finalMarkers =
    /\b(?:completed|done|finished|created|updated|verified|result|results|summary|pass|failed)\b/i.test(normalized) ||
    /(?:完成|已经|结果|产物|通过|失败)/.test(normalized);
  return !finalMarkers;
}

function isMalformedToolProtocolText(text) {
  if (!text || typeof text !== "string") {
    return false;
  }
  if (!/<\/?(?:tool_call|tool_calls|tool_use|invoke|tool_call_name)\b/i.test(text)) {
    return false;
  }
  return extractToolCallsFromText(text, []).length === 0;
}

function withToolDenialCorrection(body, tools = [], upstream = {}) {
  const priorText = openAIMessageText(upstreamAssistantMessage(upstream));
  const messages = [...(body?.messages || [])];
  if (priorText) {
    messages.push({ role: "assistant", content: priorText });
  }
  messages.push({ role: "user", content: buildToolDenialCorrection(tools) });
  return { ...body, messages };
}

function withPlanningOnlyCorrection(body, tools = [], upstream = {}) {
  const priorText = openAIMessageText(upstreamAssistantMessage(upstream));
  const messages = [...(body?.messages || [])];
  if (priorText) {
    messages.push({ role: "assistant", content: priorText });
  }
  messages.push({ role: "user", content: buildPlanningOnlyCorrection(tools) });
  return { ...body, messages };
}

function buildToolDenialCorrection(tools = []) {
  const names = toolNames(tools);
  const examples = [];
  if (names.includes("Bash")) {
    examples.push("<tool_call>{\"name\":\"Bash\",\"arguments\":{\"command\":\"pwd\",\"description\":\"Check current directory\"}}</tool_call>");
  }
  if (names.includes("Read")) {
    examples.push("<tool_call>{\"name\":\"Read\",\"arguments\":{\"file_path\":\"/absolute/path/to/file\"}}</tool_call>");
  }

  return [
    "<bridge_tool_correction>",
    `The previous response incorrectly claimed that file, shell, or host tools were unavailable. They ARE available in this Claude Code session: ${names.join(", ")}.`,
    "If the user task requires inspecting files, running shell commands, editing files, or calling MCP tools, emit the needed <tool_call>{...}</tool_call> now and no explanatory prose.",
    "Do not say you lack file, shell, filesystem, terminal, command, or tool access while these tools are listed.",
    examples.length ? `Use this exact protocol, for example: ${examples.join(" ")}` : "",
    "</bridge_tool_correction>",
  ].filter(Boolean).join("\n");
}

function buildPlanningOnlyCorrection(tools = []) {
  const names = toolNames(tools);
  const examples = [];
  if (names.includes("Bash")) {
    examples.push("<tool_call>{\"name\":\"Bash\",\"arguments\":{\"command\":\"pwd\",\"description\":\"Inspect the project root\"}}</tool_call>");
  }
  if (names.includes("Write")) {
    examples.push("<tool_call>{\"name\":\"Write\",\"arguments\":{\"file_path\":\"/absolute/path/to/file\",\"content\":\"...\"}}</tool_call>");
  }

  return [
    "<bridge_tool_correction>",
    "Your previous response only described a future plan or emitted malformed/incomplete tool XML that could not be executed.",
    `Host tools ARE available in this Claude Code session: ${names.join(", ")}.`,
    "Do not say what you will do next. Emit exactly one needed <tool_call>{...}</tool_call> now, with no prose before or after it.",
    "The tag body must be one valid JSON object with name and arguments. Do not emit nested XML tags, half-open tags, attribute-only wrappers, or bare <tool_call> text.",
    "If you need to plan, write the plan via the Write tool. If you need to inspect, use Read/Grep/LS/Bash.",
    examples.length ? `Use this protocol, for example: ${examples.join(" ")}` : "",
    "</bridge_tool_correction>",
  ].filter(Boolean).join("\n");
}

function parseJsonSafe(value) {
  if (value == null) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  if (typeof value !== "string") {
    return { value };
  }
  const cleaned = stripCodeFence(value.trim());
  for (const candidate of [cleaned, firstBalancedJson(cleaned), repairTriviallyUnbalancedJson(cleaned)].filter(Boolean)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  const repairedToolJson = repairMalformedToolJson(cleaned);
  if (repairedToolJson) {
    return repairedToolJson;
  }
  return { raw: value };
}

function stripCodeFence(value) {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : value;
}

function firstBalancedJson(value) {
  const start = value.search(/[\[{]/);
  if (start < 0) {
    return "";
  }
  const open = value[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, i + 1);
      }
    }
  }
  return "";
}

function repairTriviallyUnbalancedJson(value) {
  const trimmed = String(value || "").trim();
  const start = trimmed.search(/[\[{]/);
  if (start !== 0) {
    return "";
  }

  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      stack.push("}");
    } else if (ch === "[") {
      stack.push("]");
    } else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) {
        return "";
      }
    }
  }

  if (inString || stack.length < 1 || stack.length > 3) {
    return "";
  }
  return `${trimmed}${[...stack].reverse().join("")}`;
}

function repairMalformedToolJson(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed.startsWith("{") || !/"arguments"\s*:/.test(trimmed)) {
    return null;
  }

  const id = trimmed.match(/"id"\s*:\s*"([^"]+)"/)?.[1];
  const name = trimmed.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || trimmed.match(/"tool_name"\s*:\s*"([^"]+)"/)?.[1];
  const commaNameMatch = trimmed.match(/^\{\s*"([^"]+)"\s*,\s*"arguments"\s*:\s*([\s\S]*)\}\s*$/);
  if (!name && commaNameMatch) {
    return {
      ...(id ? { id } : {}),
      name: commaNameMatch[1],
      arguments: parseJsonSafe(commaNameMatch[2]),
    };
  }
  const commandMatch =
    trimmed.match(/"arguments"\s*:\s*"command"\s*:\s*"([\s\S]*)"\s*,\s*"description"\s*:\s*"([^"]*)"\s*\}\s*\}?$/) ||
    trimmed.match(/"arguments"\s*:\s*\{\s*"command"\s*:\s*"([\s\S]*)"\s*,\s*"description"\s*:\s*"([^"]*)"\s*\}\s*\}?$/);
  if (!name || !commandMatch) {
    return null;
  }

  return {
    ...(id ? { id } : {}),
    name,
    arguments: {
      command: commandMatch[1],
      description: commandMatch[2],
    },
  };
}

function parseXmlAttrs(attrText = "") {
  const attrs = {};
  const regexp = /([A-Za-z_:-][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = regexp.exec(attrText))) {
    attrs[match[1]] = unescapeXmlAttr(match[2]);
  }
  return attrs;
}

function unescapeXmlAttr(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeToolCalls(value, attrs = {}, toolMap = new Map()) {
  const parsed = parseJsonSafe(value);
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => normalizeToolCalls(entry, attrs, toolMap));
  }
  if (parsed?.tool_calls && Array.isArray(parsed.tool_calls)) {
    return parsed.tool_calls.flatMap((entry) => normalizeToolCalls(entry, attrs, toolMap));
  }
  if (parsed?.calls && Array.isArray(parsed.calls)) {
    return parsed.calls.flatMap((entry) => normalizeToolCalls(entry, attrs, toolMap));
  }

  const keyedCall = singleKeyedToolCall(parsed, toolMap);
  if (keyedCall) {
    return normalizeToolCalls({ name: keyedCall.name, arguments: keyedCall.input }, attrs, toolMap);
  }

  let name =
    attrs.name ||
    parsed?.name ||
    parsed?.tool_name ||
    parsed?.tool ||
    parsed?.function?.name ||
    parsed?.function_name;

  let input =
    parsed?.arguments ??
    parsed?.input ??
    parsed?.args ??
    parsed?.parameters ??
    parsed?.function?.arguments ??
    parsed?.function?.parameters;

  if (!name && attrs.tool) {
    name = attrs.tool;
  }
  if (!name && parsed && typeof parsed === "object") {
    name = inferToolNameFromInput(parsed, toolMap);
  }
  if (input == null && attrs.name && parsed && typeof parsed === "object") {
    input = parsed;
  }
  if (input == null && name && parsed && typeof parsed === "object") {
    input = parsed;
  }
  input = parseJsonSafe(input ?? {});

  if (!name || typeof name !== "string") {
    return [];
  }

  const exactName = canonicalToolName(name, toolMap);
  return [
    {
      id: parsed?.id || parsed?.tool_call_id || attrs.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: exactName,
      input: repairToolInput(exactName, input),
    },
  ];
}

function singleKeyedToolCall(parsed, toolMap = new Map()) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1) {
    return null;
  }
  const [key] = keys;
  const canonical = canonicalToolName(key, toolMap);
  if (!toolMap.has(canonical.toLowerCase())) {
    return null;
  }
  return { name: canonical, input: parsed[key] };
}

function canonicalToolName(name, toolMap = new Map()) {
  const raw = String(name || "");
  const direct = toolMap.get(raw.toLowerCase());
  if (direct) {
    return direct;
  }
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const aliases = {
    bash: "Bash",
    shell: "Bash",
    run_shell: "Bash",
    run_shell_command: "Bash",
    execute_command: "Bash",
    read: "Read",
    read_file: "Read",
    file_read: "Read",
    view_file: "Read",
    write: "Write",
    write_file: "Write",
    file_write: "Write",
    edit: "Edit",
    edit_file: "Edit",
    replace_file: "Edit",
    glob: "Glob",
    find_files: "Glob",
    grep: "Grep",
    search: "Grep",
    search_files: "Grep",
    ls: "LS",
    list_dir: "LS",
    list_directory: "LS",
  };
  const alias = aliases[normalized];
  if (alias && toolMap.has(alias.toLowerCase())) {
    return toolMap.get(alias.toLowerCase());
  }
  return raw;
}

function inferToolNameFromInput(input, toolMap = new Map()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const has = (name) => toolMap.has(name.toLowerCase()) ? toolMap.get(name.toLowerCase()) : "";
  if (input.command || input.cmd || input.shell || input.bash) {
    return has("Bash");
  }
  if (input.file_path || input.file || input.path) {
    if ((input.content || input.data || input.text) && has("Write")) {
      return has("Write");
    }
    if ((input.old_string || input.new_string || input.old || input.new || input.search || input.replace) && has("Edit")) {
      return has("Edit");
    }
    return has("Read") || has("LS");
  }
  if (input.pattern || input.query) {
    return has("Grep") || has("Glob");
  }
  return "";
}

function repairToolInput(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  const out = { ...input };
  if (name === "Bash") {
    out.command = out.command ?? out.cmd ?? out.shell ?? out.bash;
    delete out.cmd;
    delete out.shell;
    delete out.bash;
    if (!out.description && typeof out.command === "string") {
      out.description = summarizeCommand(out.command);
    }
  }
  if (name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit") {
    out.file_path = out.file_path ?? out.path ?? out.file;
    delete out.path;
    delete out.file;
  }
  if (name === "Edit") {
    out.old_string = out.old_string ?? out.old ?? out.search;
    out.new_string = out.new_string ?? out.new ?? out.replace;
    delete out.old;
    delete out.search;
    delete out.new;
    delete out.replace;
  }
  if (name === "LS") {
    out.path = out.path ?? out.directory ?? out.dir;
    delete out.directory;
    delete out.dir;
  }
  return out;
}

function summarizeCommand(command) {
  const first = command.split("\n").find((line) => line.trim()) || command;
  return truncate(first.trim(), 80);
}

function extractTaggedToolCalls(text, toolMap) {
  const calls = [];
  const tagRegexp = /<tool_calls?\b([^>]*)>([\s\S]*?)<\/tool_calls?>/gi;
  let match;
  while ((match = tagRegexp.exec(text))) {
    const attrs = parseXmlAttrs(match[1] || "");
    let body = match[2].trim();
    if (/<tool_calls?\b/i.test(body)) {
      const nestedCalls = [...extractTaggedToolCalls(body, toolMap), ...extractLooseTaggedToolCalls(body, toolMap)];
      if (nestedCalls.length) {
        calls.push(...nestedCalls);
        continue;
      }
    }
    const xmlInput = parseXmlToolInput(body);
    if (Object.keys(xmlInput).length) {
      const nameFromBody = inferToolNameFromXmlBody(body);
      calls.push(...normalizeToolCalls(xmlInput, { ...attrs, name: attrs.name || attrs.tool || nameFromBody }, toolMap));
      continue;
    }
    const argumentMatch = body.match(/<tool_call_arguments\b[^>]*>([\s\S]*?)<\/tool_call_arguments>/i);
    if (argumentMatch) {
      const name = attrs.name || attrs.tool;
      body = JSON.stringify({ name, arguments: parseJsonSafe(argumentMatch[1]) });
    }
    calls.push(...normalizeToolCalls(body, attrs, toolMap));
  }
  return calls;
}

function parseXmlToolInput(body = "") {
  const input = {};
  const argumentsMatch = body.match(/<arguments\b[^>]*>([\s\S]*?)<\/arguments>/i);
  if (argumentsMatch) {
    const rawArguments = unescapeXmlText(argumentsMatch[1].trim());
    const parsedArguments = parseJsonSafe(rawArguments);
    if (parsedArguments && typeof parsedArguments === "object" && !Array.isArray(parsedArguments)) {
      Object.assign(input, parsedArguments);
    } else {
      const xmlArguments = parseXmlToolInput(rawArguments);
      if (Object.keys(xmlArguments).length) {
        Object.assign(input, xmlArguments);
      }
    }
  }

  for (const tagName of ["parameter", "arg", "argument", "tool_argument"]) {
    const regexp = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, "gi");
    let match;
    while ((match = regexp.exec(body))) {
      const attrs = parseXmlAttrs(match[1] || "");
      const name = attrs.name || attrs.key;
      if (!name) {
        continue;
      }
      input[name] = coerceXmlToolValue(unescapeXmlText(match[2].trim()), attrs);
      if (name === "command" && attrs.description && input.description == null) {
        input.description = attrs.description;
      }
    }

    const selfClosingRegexp = new RegExp(`<${tagName}\\b([^>]*)\\/>`, "gi");
    while ((match = selfClosingRegexp.exec(body))) {
      const attrs = parseXmlAttrs(match[1] || "");
      const name = attrs.name || attrs.key;
      if (!name || attrs.value == null) {
        continue;
      }
      input[name] = coerceXmlToolValue(attrs.value, attrs);
      if (name === "command" && attrs.description && input.description == null) {
        input.description = attrs.description;
      }
    }
  }

  for (const name of ["command", "description", "file_path", "path", "content", "old_string", "new_string", "pattern", "glob", "limit"]) {
    if (input[name] != null) {
      continue;
    }
    const regexp = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, "i");
    const match = body.match(regexp);
    if (!match) {
      continue;
    }
    const attrs = parseXmlAttrs(match[1] || "");
    input[name] = coerceXmlToolValue(unescapeXmlText(match[2].trim()), attrs);
  }
  return input;
}

function inferToolNameFromXmlBody(body = "") {
  for (const tagName of ["tool_name", "name"]) {
    const toolNameMatch = body.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
    if (toolNameMatch) {
      return unescapeXmlText(toolNameMatch[1].trim());
    }
  }
  const idMatch = body.match(/<id(?:="[^"]*")?>([\s\S]*?)<\/id>/i);
  if (idMatch) {
    return unescapeXmlText(idMatch[1].trim());
  }
  return "";
}

function unescapeXmlText(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function coerceXmlToolValue(value, attrs = {}) {
  if (attrs.string === "false") {
    if (/^-?\d+$/.test(value)) {
      return Number.parseInt(value, 10);
    }
    if (/^-?\d+\.\d+$/.test(value)) {
      return Number.parseFloat(value);
    }
    if (value === "true" || value === "false") {
      return value === "true";
    }
  }
  return value;
}

function extractLooseTaggedToolCalls(text, toolMap) {
  const match = text.match(/<tool_calls?\b([^>]*)>([\s\S]*)$/i);
  if (!match) {
    return [];
  }
  const attrs = parseXmlAttrs(match[1] || "");
  const rawBody = match[2].trim();
  const xmlInput = parseXmlToolInput(rawBody);
  if (Object.keys(xmlInput).length) {
    return normalizeToolCalls(xmlInput, { ...attrs, name: attrs.name || attrs.tool || inferToolNameFromXmlBody(rawBody) }, toolMap);
  }
  const body = (firstBalancedJson(rawBody) || rawBody).trim();
  return normalizeToolCalls(body, attrs, toolMap);
}

function extractMalformedToolCallsAttrs(text, toolMap) {
  if (!/<tool_calls?\b/i.test(text)) {
    return [];
  }
  const id = text.match(/<tool_calls?\b[^>]*\bid="([^"]+)"/i)?.[1];
  const name = text.match(/<tool_calls?\b[^>]*\bname="([^"]+)"/i)?.[1] || inferToolNameFromXmlBody(text);
  const argsMatch = text.match(/<tool_calls?\b[^>]*\barguments="([\s\S]*?)(?=<\/tool_calls?>)/i);
  if (!name || !argsMatch) {
    return [];
  }
  const args = argsMatch[1].trim();
  return normalizeToolCalls(parseJsonSafe(args), { id, name }, toolMap);
}

function extractInvokeToolCalls(text, toolMap) {
  const calls = [];
  const tagRegexp = /<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/gi;
  let match;
  while ((match = tagRegexp.exec(text))) {
    const attrs = parseXmlAttrs(match[1] || "");
    const input = parseXmlToolInput(match[2] || "");
    calls.push(...normalizeToolCalls(input, attrs, toolMap));
  }
  return calls;
}

function parseToolUseAttrs(attrText = "") {
  const attrs = parseXmlAttrs(attrText);
  const inputIndex = attrText.search(/\binput\s*=/i);
  if (inputIndex >= 0) {
    const rest = attrText.slice(inputIndex).replace(/^\s*input\s*=\s*/i, "").trim();
    if (rest.startsWith("{") || rest.startsWith("[")) {
      attrs.input = firstBalancedJson(rest);
    } else {
      const quoted = rest.match(/^"([^"]*)"|^'([^']*)'/);
      if (quoted) {
        attrs.input = quoted[1] ?? quoted[2] ?? "";
      }
    }
  }
  return attrs;
}

function extractAnthropicToolUseCalls(text, toolMap) {
  const calls = [];
  const tagRegexp = /<tool_use\b([^>]*?)(?:\/>|>([\s\S]*?)<\/tool_use>)/gi;
  let match;
  while ((match = tagRegexp.exec(text))) {
    const attrs = parseToolUseAttrs(match[1] || "");
    const body = (match[2] || "").trim();
    if (!attrs.name && !attrs.tool && !attrs.input && body) {
      calls.push(...normalizeToolCalls(body, attrs, toolMap));
      continue;
    }
    const value = {
      id: attrs.id,
      name: attrs.name || attrs.tool,
      input: attrs.input ? parseJsonSafe(attrs.input) : parseJsonSafe(body || {}),
    };
    calls.push(...normalizeToolCalls(value, attrs, toolMap));
  }
  return calls;
}

function extractJsonToolCalls(text, toolMap) {
  const cleaned = stripCodeFence(text.trim());
  if (!/^\s*[\[{]/.test(cleaned)) {
    return [];
  }
  return normalizeToolCalls(cleaned, {}, toolMap);
}

function extractToolCallsFromText(text, tools = []) {
  if (!text || typeof text !== "string") {
    return [];
  }
  const toolMap = new Map((tools || []).filter((tool) => tool?.name).map((tool) => [tool.name.toLowerCase(), tool.name]));
  const malformedTagged = extractMalformedToolCallsAttrs(text, toolMap);
  if (malformedTagged.length) {
    return malformedTagged;
  }
  const tagged = extractTaggedToolCalls(text, toolMap);
  if (tagged.length) {
    return tagged;
  }
  const looseTagged = extractLooseTaggedToolCalls(text, toolMap);
  if (looseTagged.length) {
    return looseTagged;
  }
  const anthropicTagged = extractAnthropicToolUseCalls(text, toolMap);
  if (anthropicTagged.length) {
    return anthropicTagged;
  }
  const invokeTagged = extractInvokeToolCalls(text, toolMap);
  if (invokeTagged.length) {
    return invokeTagged;
  }
  return extractJsonToolCalls(text, toolMap);
}

function anthropicBlocksFromOpenAIMessage(message = {}, tools = []) {
  const blocks = [];
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    for (const toolCall of message.tool_calls) {
      blocks.push({
        type: "tool_use",
        id: toolCall.id || `toolu_${randomUUID().replaceAll("-", "")}`,
        name: toolCall.function?.name || toolCall.name || "tool",
        input: repairToolInput(toolCall.function?.name || toolCall.name || "tool", parseJsonSafe(toolCall.function?.arguments || toolCall.arguments || {})),
      });
    }
    return blocks;
  }

  const content = openAIMessageText(message);
  const parsedToolCalls = extractToolCallsFromText(content, tools);
  if (parsedToolCalls.length) {
    return parsedToolCalls.map((call) => ({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
    }));
  }

  if (content.length) {
    blocks.push({
      type: "text",
      text: content,
    });
  }
  return blocks.length ? blocks : [{ type: "text", text: "" }];
}

function anthropicStopReason(choice = {}, blocks = []) {
  if (choice.finish_reason === "tool_calls" || blocks.some((block) => block.type === "tool_use")) {
    return "tool_use";
  }
  if (choice.finish_reason === "length") {
    return "max_tokens";
  }
  return "end_turn";
}

function anthropicUsage(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0,
  };
}

function sendSseEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendAnthropicStream(res, requestBody, upstream) {
  const choice = upstream.payload.choices?.[0] || {};
  const blocks = anthropicBlocksFromOpenAIMessage(choice.message || {}, requestBody.tools || []);
  const usage = anthropicUsage(upstream.payload.usage || {});
  const stopReason = anthropicStopReason(choice, blocks);
  const message = {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: upstream.model || requestBody.model || DEFAULT_MODEL,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: 0,
    },
  };

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  sendSseEvent(res, "message_start", { type: "message_start", message });
  blocks.forEach((block, index) => sendContentBlock(res, block, index));
  sendSseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: stopReason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: usage.output_tokens,
    },
  });
  sendSseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

function sendContentBlock(res, block, index) {
  if (block.type === "tool_use") {
    sendSseEvent(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    });
    sendSseEvent(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(block.input || {}),
      },
    });
    sendSseEvent(res, "content_block_stop", { type: "content_block_stop", index });
    return;
  }

  sendSseEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text: "",
    },
  });
  sendSseEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: {
      type: "text_delta",
      text: block.text || "",
    },
  });
  sendSseEvent(res, "content_block_stop", { type: "content_block_stop", index });
}

function sendAnthropicJson(res, requestBody, upstream) {
  const choice = upstream.payload.choices?.[0] || {};
  const blocks = anthropicBlocksFromOpenAIMessage(choice.message || {}, requestBody.tools || []);
  json(res, 200, {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: upstream.model || requestBody.model || DEFAULT_MODEL,
    content: blocks,
    stop_reason: anthropicStopReason(choice, blocks),
    stop_sequence: null,
    usage: anthropicUsage(upstream.payload.usage || {}),
  });
}

function mapUpstreamError(status, payload, fallbackRaw) {
  const message =
    payload?.error?.message ||
    payload?.detail ||
    payload?.error ||
    fallbackRaw ||
    `Upstream request failed with status ${status}`;

  if (status === 401 || status === 403) {
    return anthropicError(status, "authentication_error", String(message));
  }
  if (status === 429) {
    return anthropicError(status, "rate_limit_error", String(message));
  }
  if (status >= 500) {
    return anthropicError(status, "api_error", String(message));
  }
  return anthropicError(status, "invalid_request_error", String(message));
}

function estimateTokens(body) {
  const text = JSON.stringify(body || {});
  return Math.ceil(text.length / 4);
}

async function handleModels(res) {
  const { apiKey, baseUrl } = await readUpstreamConfig();
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = { raw: text };
  }
  json(res, response.status, payload);
}

function createServer() {
  return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      const config = await readUpstreamConfig();
      json(res, 200, {
        ok: true,
        bridge: "claude-gpt-bridge",
        upstream: config.baseUrl,
        model: DEFAULT_MODEL,
        fallback_model: FALLBACK_MODEL,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      await handleModels(res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const requestBody = await readJsonBody(req);
      json(res, 200, { input_tokens: estimateTokens(requestBody) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const requestBody = await readJsonBody(req);
      await trace("anthropic_request", requestBody);
      const upstreamRequest = toOpenAIChatRequest(requestBody);
      const upstream = await callUpstreamWithFallback(upstreamRequest, { tools: requestBody.tools || [] });

      if (!upstream.ok) {
        json(res, upstream.status, mapUpstreamError(upstream.status, upstream.payload, upstream.raw));
        return;
      }

      if (requestBody.stream === false) {
        sendAnthropicJson(res, requestBody, upstream);
        return;
      }
      sendAnthropicStream(res, requestBody, upstream);
      return;
    }

    json(res, 404, anthropicError(404, "not_found_error", `Unknown route: ${req.method} ${url.pathname}`));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await trace("bridge_error", { message, stack: error?.stack });
    json(res, 500, anthropicError(500, "api_error", message));
  }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    process.stdout.write(`claude-gpt bridge listening on http://${HOST}:${PORT}\n`);
  });
}

export {
  anthropicBlocksFromOpenAIMessage,
  buildToolProtocolPrompt,
  createServer,
  extractToolCallsFromText,
  flattenAnthropicMessages,
  isToolDenialText,
  isPlanningOnlyText,
  parseJsonSafe,
  repairToolInput,
  shouldRetryPlanningOnly,
  shouldRetryToolDenial,
  shouldFallbackToFallbackModel,
  toOpenAIChatRequest,
  withPlanningOnlyCorrection,
  withToolDenialCorrection,
};
