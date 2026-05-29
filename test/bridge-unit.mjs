#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  anthropicBlocksFromOpenAIMessage,
  extractToolCallsFromText,
  flattenAnthropicMessages,
  isToolDenialText,
  parseJsonSafe,
  repairToolInput,
  shouldRetryToolDenial,
  shouldFallbackToFallbackModel,
  toOpenAIChatRequest,
  withToolDenialCorrection,
} from "../src/claude-gpt-bridge.mjs";

const tools = [
  {
    name: "Bash",
    description: "Run a bash command",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        description: { type: "string" },
      },
      required: ["command"],
    },
  },
  {
    name: "Read",
    description: "Read a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
      },
      required: ["file_path"],
    },
  },
];

assert.deepEqual(parseJsonSafe("prefix {\"a\":1} suffix"), { a: 1 });
assert.deepEqual(repairToolInput("Bash", { cmd: "pwd" }).command, "pwd");
assert.deepEqual(repairToolInput("Read", { path: "/tmp/a" }).file_path, "/tmp/a");

const jsonTag = '<tool_call>{"name":"Bash","arguments":{"cmd":"pwd"}}</tool_call>';
const jsonTagCalls = extractToolCallsFromText(jsonTag, tools);
assert.equal(jsonTagCalls.length, 1);
assert.match(jsonTagCalls[0].id, /^toolu_/);
assert.equal(jsonTagCalls[0].name, "Bash");
assert.deepEqual(jsonTagCalls[0].input, { command: "pwd", description: "pwd" });

const looseJsonTag = '<tool_call>{"name":"Bash","arguments":{"command":"printf \\"hi\\\\n\\""}}';
const looseJsonTagCalls = extractToolCallsFromText(looseJsonTag, tools);
assert.equal(looseJsonTagCalls.length, 1);
assert.equal(looseJsonTagCalls[0].name, "Bash");
assert.equal(looseJsonTagCalls[0].input.command, 'printf "hi\\n"');

const xmlTag = '<tool_call name="Read"><tool_call_arguments>{"path":"/tmp/a"}</tool_call_arguments></tool_call>';
assert.equal(extractToolCallsFromText(xmlTag, tools)[0].input.file_path, "/tmp/a");

const anthropicToolUse = 'Opening file <tool_use id="toolu_01" name="Read" input={"path":"/tmp/a"} />';
const anthropicToolUseCalls = extractToolCallsFromText(anthropicToolUse, tools);
assert.equal(anthropicToolUseCalls.length, 1);
assert.equal(anthropicToolUseCalls[0].id, "toolu_01");
assert.equal(anthropicToolUseCalls[0].name, "Read");
assert.equal(anthropicToolUseCalls[0].input.file_path, "/tmp/a");

const anthropicBodyToolUse = '<tool_use>{"tool_name":"Read","parameters":{"file_path":"/tmp/body"}}</tool_use>';
const anthropicBodyToolUseCalls = extractToolCallsFromText(anthropicBodyToolUse, tools);
assert.equal(anthropicBodyToolUseCalls.length, 1);
assert.equal(anthropicBodyToolUseCalls[0].name, "Read");
assert.equal(anthropicBodyToolUseCalls[0].input.file_path, "/tmp/body");

const blocks = anthropicBlocksFromOpenAIMessage(
  { role: "assistant", content: '<tool_call>{"name":"Bash","arguments":{"command":"ls -la"}}</tool_call>extra' },
  tools,
);
assert.equal(blocks[0].type, "tool_use");
assert.equal(blocks[0].name, "Bash");
assert.equal(blocks[0].input.command, "ls -la");

const request = toOpenAIChatRequest({
  model: "claude-sonnet-4-6",
  system: [{ type: "text", text: "You are Claude Code." }],
  tools,
  messages: [
    { role: "user", content: [{ type: "text", text: "List files." }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }],
    },
  ],
});

assert.equal(request.model, "gpt-5.5");
assert.equal(request.messages[0].role, "system");
assert.match(request.messages[0].content, /Claude Code GPT Tool Bridge/);
assert.match(request.messages[2].content, /<tool_call>/);
assert.match(request.messages[3].content, /<tool_result/);

const flattened = flattenAnthropicMessages("base system", [{ role: "user", content: "hello" }], tools);
assert.match(flattened[0].content, /base system/);
assert.match(flattened[0].content, /Available tools/);
assert.match(flattened.at(-1).content, /Host tools ARE AVAILABLE/);
assert.match(flattened.at(-1).content, /Bash\/Read\/Write\/Edit-style tools/);

const denialUpstream = {
  ok: true,
  payload: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "I don't have access to file or shell tools in this environment.",
        },
      },
    ],
  },
};
assert.equal(isToolDenialText("我没有文件或 shell 工具，无法做实验。"), true);
assert.equal(shouldRetryToolDenial(denialUpstream, tools), true);
assert.equal(shouldRetryToolDenial(denialUpstream, []), false);
assert.equal(
  shouldRetryToolDenial(
    {
      ok: true,
      payload: {
        choices: [
          {
            message: {
              role: "assistant",
              content: '<tool_call>{"name":"Bash","arguments":{"command":"pwd"}}</tool_call>',
            },
          },
        ],
      },
    },
    tools,
  ),
  false,
);

const corrected = withToolDenialCorrection({ model: "gpt-5.5", messages: [{ role: "user", content: "run tests" }] }, tools, denialUpstream);
assert.equal(corrected.messages.length, 3);
assert.match(corrected.messages.at(-1).content, /bridge_tool_correction/);
assert.match(corrected.messages.at(-1).content, /Bash/);

assert.equal(
  shouldFallbackToFallbackModel(
    { status: 503, payload: { error: { message: "No active provider key available for model 'gpt-5.5'." } } },
    "gpt-5.5",
  ),
  true,
);
assert.equal(
  shouldFallbackToFallbackModel(
    { status: 503, payload: { error: { message: "No active provider key available for model 'gpt-5.4'." } } },
    "gpt-5.4",
  ),
  false,
);

console.log("bridge-unit ok");
