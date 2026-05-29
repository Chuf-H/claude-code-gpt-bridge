#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  anthropicBlocksFromOpenAIMessage,
  extractToolCallsFromText,
  flattenAnthropicMessages,
  parseJsonSafe,
  repairToolInput,
  toOpenAIChatRequest,
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

const xmlTag = '<tool_call name="Read"><tool_call_arguments>{"path":"/tmp/a"}</tool_call_arguments></tool_call>';
assert.equal(extractToolCallsFromText(xmlTag, tools)[0].input.file_path, "/tmp/a");

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

console.log("bridge-unit ok");
