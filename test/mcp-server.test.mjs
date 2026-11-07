import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough, Readable } from "node:stream";
import { serveMcp } from "../dist/mcp-server.js";

async function exchange(
  messages,
  client = {
    request: async (method, params) =>
      method === "tools/list"
        ? { tools: [{ name: "cloving_workflows" }] }
        : { content: [{ type: "text", text: JSON.stringify(params) }] },
  },
) {
  let text = "";
  const output = new PassThrough();
  output.on("data", (chunk) => {
    text += chunk;
  });
  await serveMcp(client, {
    input: Readable.from(
      messages.map(
        (message) =>
          `${typeof message === "string" ? message : JSON.stringify(message)}\n`,
      ),
    ),
    output,
  });
  return text.trim().split("\n").filter(Boolean).map(JSON.parse);
}

test("the encrypted bridge speaks standard MCP over stdio without status text on stdout", async () => {
  const messages = await exchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "ping" },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "cloving_workflows", arguments: {} },
    },
  ]);
  assert.equal(messages.length, 4);
  assert.equal(
    messages.find((message) => message.id === 1).result.protocolVersion,
    "2025-11-25",
  );
  assert.deepEqual(messages.find((message) => message.id === 2).result, {});
  assert.equal(
    messages.find((message) => message.id === 3).result.tools[0].name,
    "cloving_workflows",
  );
  assert.equal(
    messages.find((message) => message.id === 4).result.content[0].type,
    "text",
  );
});

test("MCP reports malformed frames and offline calls without leaking exceptions or claiming a mutation failed", async () => {
  const messages = await exchange(
    [
      "{broken",
      "x".repeat(1048577),
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "cloving_run", arguments: { commandId: "retry-one" } },
      },
    ],
    {
      request: async () => {
        throw new Error("computer-offline-or-outcome-unknown");
      },
    },
  );
  assert.equal(messages[0].error.code, -32700);
  assert.equal(messages[1].error.code, -32600);
  const result = messages.find((message) => message.id === 3).result;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /same commandId/);
});

test("modern MCP uses stateless discovery, validates request metadata, and returns typed results", async () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  const messages = await exchange([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: meta },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: meta } },
    { jsonrpc: "2.0", id: 3, method: "server/discover", params: {} },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/list",
      params: {
        _meta: {
          ...meta,
          "io.modelcontextprotocol/protocolVersion": "2099-01-01",
        },
      },
    },
  ]);
  assert.ok(
    messages
      .find((message) => message.id === 1)
      .result.supportedVersions.includes("2026-07-28"),
  );
  assert.equal(
    messages.find((message) => message.id === 2).result.resultType,
    "complete",
  );
  assert.equal(messages.find((message) => message.id === 3).error.code, -32602);
  for (const id of [1, 2]) {
    assert.equal(messages.find((message) => message.id === id).result.ttlMs, 0);
    assert.equal(
      messages.find((message) => message.id === id).result.cacheScope,
      "private",
    );
  }
  assert.equal(messages.find((message) => message.id === 4).error.code, -32022);
});

test("offline tools/list returns a protocol error rather than a malformed successful discovery result", async () => {
  const [reply] = await exchange(
    [{ jsonrpc: "2.0", id: 1, method: "tools/list" }],
    {
      request: async () => {
        throw new Error("relay-unavailable");
      },
    },
  );
  assert.equal(reply.error.code, -32603);
  assert.equal(reply.result, undefined);
});

test("signal shutdown stops pending polls and closes stdio cleanly without claiming to retract admitted commands", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const serving = serveMcp(
    { request: async () => ({ tools: [] }) },
    { input, output, signal: controller.signal },
  );
  controller.abort();
  await serving;
});

test("cancelling pending tool discovery sends no further reply", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => {
    text += chunk;
  });
  const serving = serveMcp(
    {
      request: async (method, params, signal) =>
        new Promise((resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        ),
    },
    { input, output },
  );
  input.end(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })}\n`,
  );
  await serving;
  assert.equal(text, "");
});
