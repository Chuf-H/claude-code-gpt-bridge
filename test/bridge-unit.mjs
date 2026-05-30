#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  anthropicBlocksFromOpenAIMessage,
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
  {
    name: "Write",
    description: "Write a file",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string" },
        content: { type: "string" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "Glob",
    description: "Find files",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
      },
      required: ["pattern"],
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

const missingOuterBraceTag = '<tool_call>{"id":"toolu_missing","name":"Bash","arguments":{"command":"pwd","description":"Check directory"}</tool_call>';
const missingOuterBraceCalls = extractToolCallsFromText(missingOuterBraceTag, tools);
assert.equal(missingOuterBraceCalls.length, 1);
assert.equal(missingOuterBraceCalls[0].id, "toolu_missing");
assert.equal(missingOuterBraceCalls[0].name, "Bash");
assert.deepEqual(missingOuterBraceCalls[0].input, { command: "pwd", description: "Check directory" });

const malformedArgumentsTag = `<tool_call>{"id":"toolu_malformed","name":"Bash","arguments":"command":"python3 -c "
print('hi')
" 2>&1","description":"Run inline python"}</tool_call>`;
const malformedArgumentsCalls = extractToolCallsFromText(malformedArgumentsTag, tools);
assert.equal(malformedArgumentsCalls.length, 1);
assert.equal(malformedArgumentsCalls[0].id, "toolu_malformed");
assert.equal(malformedArgumentsCalls[0].name, "Bash");
assert.match(malformedArgumentsCalls[0].input.command, /print\('hi'\)/);
assert.equal(malformedArgumentsCalls[0].input.description, "Run inline python");

const malformedObjectArgumentsTag = `<tool_call>{"id":"toolu_obj","name":"Bash","arguments":{"command":"python3 -c "
print('hi')
" 2>&1","description":"Run inline python"}}</tool_call>`;
const malformedObjectArgumentsCalls = extractToolCallsFromText(malformedObjectArgumentsTag, tools);
assert.equal(malformedObjectArgumentsCalls.length, 1);
assert.equal(malformedObjectArgumentsCalls[0].id, "toolu_obj");
assert.equal(malformedObjectArgumentsCalls[0].name, "Bash");
assert.match(malformedObjectArgumentsCalls[0].input.command, /print\('hi'\)/);
assert.equal(malformedObjectArgumentsCalls[0].input.description, "Run inline python");

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

const nestedToolCall = `<tool_call>
<tool_call name="Bash">
{"command":"pwd"}
</tool_call>
</tool_call>`;
const nestedToolCalls = extractToolCallsFromText(nestedToolCall, tools);
assert.equal(nestedToolCalls.length, 1);
assert.equal(nestedToolCalls[0].name, "Bash");
assert.equal(nestedToolCalls[0].input.command, "pwd");

const parameterOnlyToolCall = `<tool_call>
<parameter name="file_path">/tmp/parameter.md</parameter>
</tool_call>`;
const parameterOnlyToolCalls = extractToolCallsFromText(parameterOnlyToolCall, tools);
assert.equal(parameterOnlyToolCalls.length, 1);
assert.equal(parameterOnlyToolCalls[0].name, "Read");
assert.equal(parameterOnlyToolCalls[0].input.file_path, "/tmp/parameter.md");

const invokeToolCall = `<tool_calls>
<invoke name="Read">
<parameter name="file_path" string="true">/tmp/invoke.md</parameter>
<parameter name="limit" string="false">60</parameter>
</invoke>
</tool_calls>`;
const invokeToolCalls = extractToolCallsFromText(invokeToolCall, tools);
assert.equal(invokeToolCalls.length, 1);
assert.equal(invokeToolCalls[0].name, "Read");
assert.equal(invokeToolCalls[0].input.file_path, "/tmp/invoke.md");
assert.equal(invokeToolCalls[0].input.limit, 60);

const argToolCall = `<tool_call><id="toolu_abc">Bash</id>
<arg name="command">pwd</arg>
<arg name="description">Print working directory</arg>
</tool_call>`;
const argToolCalls = extractToolCallsFromText(argToolCall, tools);
assert.equal(argToolCalls.length, 1);
assert.equal(argToolCalls[0].name, "Bash");
assert.equal(argToolCalls[0].input.command, "pwd");
assert.equal(argToolCalls[0].input.description, "Print working directory");

const directXmlToolCall = `<tool_call>
<tool_call name="Bash">
<command>pwd</command>
<description>Print working directory</description>
</tool_call>
</tool_call>`;
const directXmlToolCalls = extractToolCallsFromText(directXmlToolCall, tools);
assert.equal(directXmlToolCalls.length, 1);
assert.equal(directXmlToolCalls[0].name, "Bash");
assert.equal(directXmlToolCalls[0].input.command, "pwd");

const toolArgumentXmlCall = `<tool_call>
  <tool_name>Bash</tool_name>
  <tool_args>
    <tool_argument name="command" value="pwd"/>
    <tool_argument name="description" value="Print working directory"/>
  </tool_args>
</tool_call>`;
const toolArgumentXmlCalls = extractToolCallsFromText(toolArgumentXmlCall, tools);
assert.equal(toolArgumentXmlCalls.length, 1);
assert.equal(toolArgumentXmlCalls[0].name, "Bash");
assert.equal(toolArgumentXmlCalls[0].input.command, "pwd");
assert.equal(toolArgumentXmlCalls[0].input.description, "Print working directory");

const argumentXmlCall = `<tool_call>
<tool_call id="toolu_argument" name="Bash">
<argument name="command" description="Print working directory">pwd</argument>
</tool_call>
</tool_call>`;
const argumentXmlCalls = extractToolCallsFromText(argumentXmlCall, tools);
assert.equal(argumentXmlCalls.length, 1);
assert.equal(argumentXmlCalls[0].id, "toolu_argument");
assert.equal(argumentXmlCalls[0].name, "Bash");
assert.equal(argumentXmlCalls[0].input.command, "pwd");
assert.equal(argumentXmlCalls[0].input.description, "Print working directory");

const nameArgumentsXmlCall = `<tool_call>
<name>Bash</name>
<arguments>{"command":"ls /tmp/x 2>/dev/null && echo \\"EXISTS\\" || echo \\"MISSING\\"","description":"Check unified benchmark JSON exists"}</arguments>
</tool_call>`;
const nameArgumentsXmlCalls = extractToolCallsFromText(nameArgumentsXmlCall, tools);
assert.equal(nameArgumentsXmlCalls.length, 1);
assert.equal(nameArgumentsXmlCalls[0].name, "Bash");
assert.match(nameArgumentsXmlCalls[0].input.command, /echo "EXISTS"/);
assert.equal(nameArgumentsXmlCalls[0].input.description, "Check unified benchmark JSON exists");

const keyedReadFileCall = `<tool_call>
{"read_file":{"file_path":"/tmp/unified.json","limit":150}}
</tool_call>`;
const keyedReadFileCalls = extractToolCallsFromText(keyedReadFileCall, tools);
assert.equal(keyedReadFileCalls.length, 1);
assert.equal(keyedReadFileCalls[0].name, "Read");
assert.equal(keyedReadFileCalls[0].input.file_path, "/tmp/unified.json");
assert.equal(keyedReadFileCalls[0].input.limit, 150);

const commaNameArgumentsCall = `<tool_call>{"read_file","arguments":{"file_path":"/tmp/round94.py"}}</tool_call>`;
const commaNameArgumentsCalls = extractToolCallsFromText(commaNameArgumentsCall, tools);
assert.equal(commaNameArgumentsCalls.length, 1);
assert.equal(commaNameArgumentsCalls[0].name, "Read");
assert.equal(commaNameArgumentsCalls[0].input.file_path, "/tmp/round94.py");

const pluralAttrToolCalls = `<tool_calls>
<tool_calls id="toolu_plural_attr">
<tool_calls name="Bash">
<tool_calls arguments="{"command":"mkdir -p /tmp/bridge-test","description":"Ensure directory exists"}</tool_calls>
</tool_calls>
</tool_calls>`;
const pluralAttrCalls = extractToolCallsFromText(pluralAttrToolCalls, tools);
assert.equal(pluralAttrCalls.length, 1);
assert.equal(pluralAttrCalls[0].id, "toolu_plural_attr");
assert.equal(pluralAttrCalls[0].name, "Bash");
assert.equal(pluralAttrCalls[0].input.command, "mkdir -p /tmp/bridge-test");
assert.equal(pluralAttrCalls[0].input.description, "Ensure directory exists");

const pluralJsonToolCalls = `<tool_calls>
<tool_calls>
<tool_calls>{"name":"Write","arguments":{"file_path":"/tmp/report.md","content":"hello"}}</tool_calls>
</tool_calls>
</tool_calls>`;
const pluralJsonCalls = extractToolCallsFromText(pluralJsonToolCalls, tools);
assert.equal(pluralJsonCalls.length, 1);
assert.equal(pluralJsonCalls[0].name, "Write");
assert.equal(pluralJsonCalls[0].input.file_path, "/tmp/report.md");
assert.equal(pluralJsonCalls[0].input.content, "hello");

const blocks = anthropicBlocksFromOpenAIMessage(
  { role: "assistant", content: '<tool_call>{"name":"Bash","arguments":{"command":"ls -la"}}</tool_call>extra' },
  tools,
);
assert.equal(blocks[0].type, "tool_use");
assert.equal(blocks[0].name, "Bash");
assert.equal(blocks[0].input.command, "ls -la");

const arrayContentBlocks = anthropicBlocksFromOpenAIMessage(
  {
    role: "assistant",
    content: [
      { type: "text", text: 'First I will execute.\n<tool_call>{"id":"toolu_array","name":"Write","arguments":{"file_path":"/tmp/array.md","content":"hello"}}</tool_call>' },
    ],
  },
  tools,
);
assert.equal(arrayContentBlocks[0].type, "tool_use");
assert.equal(arrayContentBlocks[0].id, "toolu_array");
assert.equal(arrayContentBlocks[0].name, "Write");
assert.equal(arrayContentBlocks[0].input.file_path, "/tmp/array.md");
assert.equal(arrayContentBlocks[0].input.content, "hello");

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

const planningOnlyUpstream = {
  ok: true,
  payload: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "I'll inspect the newest logs, then run one focused test and update the report.",
        },
      },
    ],
  },
};
assert.equal(isPlanningOnlyText("I'll inspect the newest logs, then run one focused test."), true);
assert.equal(isPlanningOnlyText("Round 45 completed and wrote the results."), false);
assert.equal(shouldRetryPlanningOnly(planningOnlyUpstream, tools), true);
assert.equal(shouldRetryPlanningOnly(planningOnlyUpstream, []), false);
const malformedToolProtocolUpstream = {
  ok: true,
  payload: {
    choices: [
      {
        message: {
          role: "assistant",
          content: `<tool_call>
<tool_call_name="Write</tool_call_name>
<tool_call_name="file_path</tool_call_name>/tmp/current_round_plan.md</tool_call_name>"
</tool>`,
        },
      },
    ],
  },
};
assert.equal(shouldRetryPlanningOnly(malformedToolProtocolUpstream, tools), true);
const repeatedOpenTagProtocolUpstream = {
  ok: true,
  payload: {
    choices: [
      {
        message: {
          role: "assistant",
          content: `<tool_call>
<tool_call name="Edit">
<tool_call id="toolu_bdrk_01FE6UC2nCWb5grQb7a8osct" name="Edit">`,
        },
      },
    ],
  },
};
assert.equal(shouldRetryPlanningOnly(repeatedOpenTagProtocolUpstream, tools), true);
assert.equal(
  shouldRetryPlanningOnly(
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
const planningCorrected = withPlanningOnlyCorrection({ model: "gpt-5.5", messages: [{ role: "user", content: "run tests" }] }, tools, planningOnlyUpstream);
assert.equal(planningCorrected.messages.length, 3);
assert.match(planningCorrected.messages.at(-1).content, /only described a future plan/);
assert.match(planningCorrected.messages.at(-1).content, /<tool_call>/);

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
assert.equal(
  shouldFallbackToFallbackModel(
    { status: 502, payload: { error: { message: "upstream_fetch_failed after 3/3 attempt(s): fetch failed" } } },
    "gpt-5.5",
  ),
  true,
);

console.log("bridge-unit ok");
