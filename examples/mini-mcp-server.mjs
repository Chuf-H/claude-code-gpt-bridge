#!/usr/bin/env node

import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const tools = [
  {
    name: "sum_numbers",
    description: "Return the sum of an array of numbers.",
    inputSchema: {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: { type: "number" },
        },
      },
      required: ["numbers"],
      additionalProperties: false,
    },
  },
];

rl.on("line", (line) => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!("id" in message)) {
    return;
  }

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "mini-calc",
        version: "1.0.0",
      },
    });
    return;
  }

  if (message.method === "tools/list") {
    result(message.id, { tools });
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name !== "sum_numbers") {
      error(message.id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const numbers = message.params?.arguments?.numbers || [];
    const sum = numbers.reduce((acc, value) => acc + Number(value), 0);
    result(message.id, {
      content: [
        {
          type: "text",
          text: `MCP_SUM=${sum}`,
        },
      ],
      isError: false,
    });
    return;
  }

  error(message.id, -32601, `Unknown method: ${message.method}`);
});
