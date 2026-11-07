import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "../dist/identity.js";
import { LocalConnection } from "../dist/local.js";
import { sealMessage, openMessage } from "../dist/protocol.js";

test("a locally granted workflow start uses a stable command ID and exports only its safe state", async () => {
  const daemon = newIdentity();
  const client = newIdentity();
  const config = {
    version: 1,
    connectionId: "conn-1",
    keys: daemon,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
    workflows: ["develop"],
  };
  const calls = [];
  const replies = [];
  const agent = new LocalConnection(config, {
    send: async (request) => {
      calls.push(request);
      return {
        ok: true,
        result: {
          runId: "run-1",
          kind: "run-admitted",
          receipt: { private: "secret receipt" },
        },
      };
    },
    publish: async (message) => replies.push(message),
    remember: async () => {},
    known: async () => undefined,
    now: () => Date.now(),
  });
  const now = Date.now();
  const request = {
    version: 1,
    connectionId: "conn-1",
    direction: "request",
    messageId: "transport-1",
    channel: "request",
    issuedAt: now,
    expiresAt: now + 60000,
    body: {
      operation: "run",
      requestId: "request-1",
      workflowId: "develop",
      input: { prompt: "private task" },
    },
  };
  const ciphertext = await sealMessage(
    client,
    daemon.agreementPublicKey,
    { connectionId: "conn-1", direction: "request" },
    request,
  );
  await agent.receive({
    message_id: "transport-1",
    channel: "request",
    ciphertext,
  });
  assert.equal(calls[0].operation, "run");
  assert.deepEqual(calls[0].parameters.submission, { prompt: "private task" });
  assert.match(calls[0].parameters.commandId, /^zapier-/);
  const opened = await openMessage(
    client,
    daemon.signingPublicKey,
    { connectionId: "conn-1", direction: "response" },
    replies[0].ciphertext,
  );
  assert.equal(opened.body.run_id, "run-1");
  assert.equal(opened.body.delivery_status, "admitted");
  assert.equal(JSON.stringify(opened).includes("secret receipt"), false);
});

function scenario() {
  const keys = newIdentity();
  const client = newIdentity();
  const config = {
    version: 1,
    connectionId: "conn-1",
    keys,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
    workflows: ["develop"],
  };
  const stored = new Map();
  const calls = [];
  const replies = [];
  const ports = {
    send: async (request) => {
      calls.push(request);
      return { ok: true, result: { runId: "run-1", kind: "run-admitted" } };
    },
    publish: async (message) => replies.push(message),
    remember: async (key, value) => stored.set(key, value),
    known: async (key) => stored.get(key),
    now: () => Date.now(),
  };
  const encode = async (body = {}, overrides = {}) => {
    const now = Date.now();
    const value = {
      version: 1,
      connectionId: "conn-1",
      direction: "request",
      messageId: "transport-1",
      channel: "request",
      issuedAt: now,
      expiresAt: now + 60000,
      body: {
        operation: "run",
        requestId: "request-1",
        workflowId: "develop",
        input: { prompt: "private task" },
        ...body,
      },
      ...overrides,
    };
    return {
      message_id: "transport-1",
      channel: "request",
      ciphertext: await sealMessage(
        client,
        keys.agreementPublicKey,
        { connectionId: "conn-1", direction: "request" },
        value,
      ),
    };
  };
  const lastReply = async () =>
    (
      await openMessage(
        client,
        keys.signingPublicKey,
        { connectionId: "conn-1", direction: "response" },
        replies.at(-1).ciphertext,
      )
    ).body;
  return {
    config,
    ports,
    encode,
    lastReply,
    calls,
    replies,
    stored,
    agent: new LocalConnection(config, ports),
  };
}

test("a workflow absent from the local grant is refused before reaching Cloving", async () => {
  const s = scenario();
  await s.agent.receive(await s.encode({ workflowId: "deploy-production" }));
  assert.equal(s.calls.length, 0);
  assert.equal((await s.lastReply()).error, "workflow-not-allowed");
});

test("an approval operation is refused even with valid client keys", async () => {
  const s = scenario();
  await s.agent.receive(await s.encode({ operation: "decision" }));
  assert.equal(s.calls.length, 0);
  assert.equal((await s.lastReply()).error, "operation-not-allowed");
});

test("expired requests never start on a computer that wakes later", async () => {
  const s = scenario();
  await s.agent.receive(
    await s.encode(
      {},
      { issuedAt: Date.now() - 120000, expiresAt: Date.now() - 60000 },
    ),
  );
  assert.equal(s.calls.length, 0);
  assert.equal((await s.lastReply()).error, "request-expired");
});

test("a signed message with a substituted transport identity is rejected", async () => {
  const s = scenario();
  await assert.rejects(
    s.agent.receive(await s.encode({}, { connectionId: "conn-2" })),
    /message-binding-invalid/,
  );
  assert.equal(s.calls.length, 0);
});

test("a retry after adapter restart returns the original admission and changed input conflicts", async () => {
  const s = scenario();
  await s.agent.receive(await s.encode());
  const restarted = new LocalConnection(s.config, s.ports);
  await restarted.receive(await s.encode());
  assert.equal(s.calls.length, 1);
  assert.equal((await s.lastReply()).run_id, "run-1");
  await restarted.receive(
    await s.encode({ input: { prompt: "different task" } }),
  );
  assert.equal(s.calls.length, 1);
  assert.equal((await s.lastReply()).error, "conflicting-command");
});

test("refresh publishes permitted run state without exporting its prompt or raw outcome", async () => {
  const s = scenario();
  await s.agent.receive(await s.encode());
  let reads = 0;
  const ports = {
    ...s.ports,
    records: async () => [...s.stored.entries()],
    send: async () => {
      reads++;
      return {
        ok: true,
        result: {
          run: {
            runId: "run-1",
            workflowId: "develop",
            state: "completed",
            revision: 4,
            latestSequence: 8,
            input: { prompt: "private prompt" },
            outcome: { secret: "raw result" },
          },
        },
      };
    },
  };
  const agent = new LocalConnection(s.config, ports);
  await agent.refresh();
  assert.equal(s.replies.filter((row) => row.channel === "event").length, 1);
  assert.equal(s.replies.filter((row) => row.channel === "state").length, 1);
  assert.equal((await s.lastReply()).state, "completed");
  assert.equal(
    JSON.stringify(await s.lastReply()).includes("private prompt"),
    false,
  );
  assert.equal(
    JSON.stringify(await s.lastReply()).includes("raw result"),
    false,
  );
  await agent.refresh();
  assert.equal(s.replies.filter((row) => row.channel === "event").length, 1);
  assert.equal(reads, 1);
});

test("an unknown submission outcome is retained for retry with the same command ID", async () => {
  const s = scenario();
  const agent = new LocalConnection(s.config, {
    ...s.ports,
    send: async () => ({ ok: false, error: { code: "outcome-unknown" } }),
  });
  await assert.rejects(agent.receive(await s.encode()), /service-unavailable/);
  assert.equal(s.replies.length, 0);
});
