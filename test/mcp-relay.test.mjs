import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "../dist/identity.js";
import { openMessage, sealMessage } from "../dist/protocol.js";
import { McpClient, createMcpBridge } from "../dist/mcp-relay.js";

function fixture(overrides = {}) {
  const daemon = newIdentity();
  const client = newIdentity();
  const config = {
    version: 1,
    integration: "mcp",
    connectionId: "test-connection",
    origin: "https://cloving.ai",
    runtimeDirectory: "/unused",
    daemonId: "daemon",
    daemonToken: "daemon-token",
    keys: daemon,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
    workflows: ["develop"],
    permissions: ["read", "start"],
  };
  const credential = {
    version: 1,
    origin: config.origin,
    connectionId: config.connectionId,
    token: "client-token",
    keys: client,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  const rows = [];
  const wire = [];
  const records = new Map();
  const sent = [];
  const transport = async (method, path, body) => {
    wire.push({ method, path, body });
    if (method === "POST") {
      rows.push(body);
      return {};
    }
    if (method === "DELETE") {
      const index = rows.findIndex(
        (row) => row.message_id === path.split("/").at(-1),
      );
      if (index >= 0) rows.splice(index, 1);
      return {};
    }
    const query = new URL(path, config.origin).searchParams;
    return {
      messages: rows
        .filter(
          (row) =>
            row.channel === query.get("channel") &&
            (!query.has("slot") || row.slot === query.get("slot")),
        )
        .toReversed(),
    };
  };
  const ports = {
    transport,
    service: async (request) => {
      sent.push(request);
      return {
        ok: true,
        result:
          request.operation === "run"
            ? { runId: "run-one" }
            : { workflows: ["develop"], runs: [] },
      };
    },
    fields: async () => ({}),
    store: {
      read: async (key) => records.get(key),
      write: async (key, value) => records.set(key, value),
    },
    revoked: async () => false,
    ...overrides,
  };
  const bridge = createMcpBridge(config, ports);
  const remote = new McpClient(credential, transport, {
    wait: async () => bridge.tick(),
    timeoutMs: 1000,
  });
  return {
    config,
    credential,
    remote,
    bridge,
    rows,
    wire,
    sent,
    transport,
    records,
    ports,
  };
}

test("MCP calls cross the opaque relay and retries return the same durable command receipt", async () => {
  const f = fixture();
  const call = {
    name: "cloving_run",
    arguments: {
      workflowId: "develop",
      input: { prompt: "MCP_SECRET_482901" },
      commandId: "one",
    },
  };
  const first = await f.remote.request("tools/call", call);
  const again = await f.remote.request("tools/call", call);
  assert.equal(first.structuredContent.runId, "run-one");
  assert.deepEqual(again, first);
  assert.deepEqual(
    await f.remote.request("tools/call", {
      ...call,
      _meta: { progressToken: "new-progress-token" },
    }),
    first,
  );
  assert.equal(
    f.sent.filter((request) => request.operation === "run").length,
    1,
  );
  assert.match(f.sent[0].parameters.commandId, /^mcp-[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(f.wire).includes("MCP_SECRET_482901"));
  assert.ok(
    !JSON.stringify(f.wire).includes(f.credential.keys.agreementPrivateKey),
  );
  const changed = await f.remote.request("tools/call", {
    ...call,
    arguments: { ...call.arguments, input: { prompt: "different" } },
  });
  assert.equal(changed.structuredContent.error, "conflicting-command");
});

test("a lost decision acknowledgement survives a bridge restart and replays the exact already-authorized command", async () => {
  let submitted = false;
  let effects = 0;
  const digest = `sha256:${"a".repeat(64)}`;
  const f = fixture({
    service: async ({ operation }) => {
      if (operation === "status")
        return {
          ok: true,
          result: { run: { runId: "mine", workflowId: "develop" } },
        };
      if (operation === "questions")
        return {
          ok: true,
          result: {
            decisions: submitted
              ? []
              : [
                  {
                    decisionId: "gate",
                    runId: "mine",
                    revision: 1,
                    generation: 1,
                    subjectDigest: digest,
                  },
                ],
          },
        };
      if (operation === "decision" && !submitted) {
        submitted = true;
        effects++;
        throw new Error("service-unavailable");
      }
      return { ok: true, result: { replayed: true, runId: "mine" } };
    },
  });
  const config = { ...f.config, permissions: ["read", "approve"] };
  const bridge = createMcpBridge(config, f.ports);
  let restarted;
  const remote = new McpClient(f.credential, f.transport, {
    timeoutMs: 1000,
    wait: async () => {
      try {
        await (restarted ?? bridge).tick();
      } catch {
        restarted = createMcpBridge(config, f.ports);
      }
    },
  });
  const reply = await remote.request("tools/call", {
    name: "cloving_approve",
    arguments: {
      runId: "mine",
      reference: "gate",
      expectedRevision: 1,
      generation: 1,
      subjectDigest: digest,
      commandId: "approve-once",
    },
  });
  assert.equal(reply.structuredContent.replayed, true);
  assert.equal(effects, 1);
});

test("MCP rejects tampering, wrong peers, cross-protocol messages, malformed signed requests, and expired commands", async () => {
  const f = fixture();
  const now = Date.now();
  const send = async (overrides = {}, keys = f.credential.keys) => {
    const id = `message-${f.rows.length}`;
    const envelope = {
      version: 1,
      connectionId: f.config.connectionId,
      direction: "request",
      channel: "request",
      messageId: id,
      issuedAt: now,
      expiresAt: now + 30000,
      body: {
        protocol: "mcp-v1",
        requestId: "security-request",
        method: "tools/call",
        params: {
          name: "cloving_run",
          arguments: { workflowId: "develop", input: {}, commandId: "one" },
        },
      },
      ...overrides,
    };
    const ciphertext = await sealMessage(
      keys,
      f.config.keys.agreementPublicKey,
      { connectionId: f.config.connectionId, direction: "request" },
      envelope,
    );
    f.rows.push({ message_id: id, channel: "request", ciphertext });
  };
  await send({}, newIdentity());
  await send({ connectionId: "another-connection" });
  await send({ body: { protocol: "zapier", requestId: "wrong-protocol" } });
  await send({ body: { protocol: "mcp-v1", requestId: "malformed" } });
  await send({ issuedAt: now - 2000, expiresAt: now - 1000 });
  await f.bridge.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.rows.filter((row) => row.channel === "request").length, 0);
  const reply = await openMessage(
    f.credential.keys,
    f.config.keys.signingPublicKey,
    { connectionId: f.config.connectionId, direction: "response" },
    f.rows.find((row) => row.channel === "reply").ciphertext,
  );
  assert.equal(reply.body.result.structuredContent.error, "request-expired");
});

test("an oversized permitted run reply becomes a small encrypted error and does not block later requests", async () => {
  const f = fixture({
    service: async () => ({
      ok: true,
      result: {
        run: {
          runId: "mine",
          workflowId: "develop",
          outcome: "x".repeat(40000),
        },
      },
    }),
  });
  const reply = await f.remote.request("tools/call", {
    name: "cloving_status",
    arguments: { runId: "mine" },
  });
  assert.equal(reply.structuredContent.error, "result-too-large");
  assert.ok((await f.remote.request("tools/list", {})).tools.length > 0);
});
