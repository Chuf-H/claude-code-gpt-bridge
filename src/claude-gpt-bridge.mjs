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
  return [
    "## Claude Code GPT Tool Bridge",
    "",
    "You are the model backend for Claude Code. You do not have direct filesystem, shell, network, or editor access. When you need to inspect files, run commands, or edit files, you must request one of the host tools below. The bridge will convert your request into Claude Code tool_use blocks, Claude Code will execute the tool, and you will receive a <tool_result> message.",
    "",
    "Tool-call protocol:",
    "- If a tool is needed, output only one or more tool call tags and no explanatory prose.",
    "- Exact format: <tool_call>{\"name\":\"ToolName\",\"arguments\":{...}}</tool_call>",
    "- Tool names are case-sensitive. The arguments object must match the selected tool's input_schema.",
    "- Multiple independent tool calls may be emitted as multiple adjacent <tool_call>...</tool_call> tags.",
    "- Do not wrap tool calls in Markdown fences. Do not invent tool results. After receiving tool results, continue with another tool call or a normal final answer.",
    "- For Bash, use the key \"command\" for the shell command and include a short \"description\" when possible.",
    "- For Read, Write, Edit, MultiEdit, Grep, Glob, and LS, use the exact field names shown in their schemas.",
    "- If no tool is needed, answer normally without any <tool_call> tags.",
    "",
    "Available tools:",
    "```json",
    toolBlock,
    "```",
  ].join("\n");
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    await trace("upstream_request", payload);
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
    await trace("upstream_response", { status: response.status, ok: response.ok, payload: parsed });
    return {
      ok: response.ok,
      status: response.status,
      payload: parsed,
      raw: text,
      model: payload.model,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callUpstreamWithFallback(body) {
  const first = await callUpstreamChat(body);
  if (first.ok || body.model === FALLBACK_MODEL) {
    return first;
  }
  const message = upstreamErrorMessage(first);
  if (first.status === 400 && /model|unsupported|not supported|Instructions are required/i.test(message)) {
    const fallback = await callUpstreamChat(body, FALLBACK_MODEL);
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
  for (const candidate of [cleaned, firstBalancedJson(cleaned)].filter(Boolean)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
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
  if (input == null && attrs.name && parsed && typeof parsed === "object") {
    input = parsed;
  }
  input = parseJsonSafe(input ?? {});

  if (!name || typeof name !== "string") {
    return [];
  }

  const exactName = toolMap.get(name.toLowerCase()) || name;
  return [
    {
      id: parsed?.id || parsed?.tool_call_id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: exactName,
      input: repairToolInput(exactName, input),
    },
  ];
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
  const tagRegexp = /<tool_call\b([^>]*)>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = tagRegexp.exec(text))) {
    const attrs = parseXmlAttrs(match[1] || "");
    let body = match[2].trim();
    const argumentMatch = body.match(/<tool_call_arguments\b[^>]*>([\s\S]*?)<\/tool_call_arguments>/i);
    if (argumentMatch) {
      const name = attrs.name || attrs.tool;
      body = JSON.stringify({ name, arguments: parseJsonSafe(argumentMatch[1]) });
    }
    calls.push(...normalizeToolCalls(body, attrs, toolMap));
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
  const tagged = extractTaggedToolCalls(text, toolMap);
  if (tagged.length) {
    return tagged;
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

  const content = typeof message.content === "string" ? message.content : "";
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

    if (req.method === "GET" && url.pathname === "/healthz") {
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
      const upstream = await callUpstreamWithFallback(upstreamRequest);

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
  parseJsonSafe,
  repairToolInput,
  toOpenAIChatRequest,
};
