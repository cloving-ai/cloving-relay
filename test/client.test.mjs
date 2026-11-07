import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "../dist/identity.js";
import { Client } from "../dist/client.js";
import { openMessage, sealMessage } from "../dist/protocol.js";

test("Start Workflow sends only ciphertext and retains its request ID across Zapier retries", async () => {
  const client = newIdentity();
  const daemon = newIdentity();
  const credential = {
    version: 1,
    origin: "https://cloving.ai",
    connectionId: "conn-1",
    token: "transport-token",
    keys: client,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  const calls = [];
  const zapier = new Client(credential, async (method, path, body) => {
    calls.push({ method, path, body });
    return {};
  });
  const first = await zapier.start({
    workflowId: "develop",
    requestKey: "source-event-123",
    input: { prompt: "sensitive task" },
  });
  const retry = await zapier.start({
    workflowId: "develop",
    requestKey: "source-event-123",
    input: { prompt: "sensitive task" },
  });
  assert.equal(first.request_id, retry.request_id);
  assert.equal(first.delivery_status, "queued");
  assert.equal(first.run_id, null);
  assert.equal(JSON.stringify(calls).includes("sensitive task"), false);
  assert.equal(JSON.stringify(calls).includes("PrivateKey"), false);
  const opened = await openMessage(
    daemon,
    client.signingPublicKey,
    { connectionId: "conn-1", direction: "request" },
    calls[0].body.ciphertext,
  );
  assert.equal(opened.body.input.prompt, "sensitive task");
  assert.equal(opened.body.requestId, first.request_id);
});

test("a state response is decrypted only after signature and routing checks", async () => {
  const client = newIdentity();
  const daemon = newIdentity();
  const credential = {
    version: 1,
    origin: "https://cloving.ai",
    connectionId: "conn-1",
    token: "transport-token",
    keys: client,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  const now = Date.now();
  const message = {
    version: 1,
    connectionId: "conn-1",
    direction: "response",
    messageId: "reply-1",
    channel: "event",
    slot: "run-slot",
    issuedAt: now,
    expiresAt: now + 60000,
    body: {
      id: "event-1",
      run_id: "run-1",
      state: "completed",
      observed_at: new Date(now).toISOString(),
    },
  };
  const row = {
    message_id: "reply-1",
    channel: "event",
    slot: "run-slot",
    ciphertext: await sealMessage(
      daemon,
      client.agreementPublicKey,
      { connectionId: "conn-1", direction: "response" },
      message,
    ),
  };
  const zapier = new Client(credential, async () => ({ messages: [row] }));
  assert.equal((await zapier.events())[0].state, "completed");
  row.message_id = "substituted";
  await assert.rejects(zapier.events(), /message-binding-invalid/);
});

test("Get Workflow Run resolves an admitted request to its cached signed run state", async () => {
  const keys = newIdentity();
  const daemon = newIdentity();
  const credential = {
    version: 1,
    origin: "https://cloving.ai",
    connectionId: "conn-1",
    token: "transport-token",
    keys,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  const query = [];
  const zapier = new Client(credential, async (method, path) => {
    const url = new URL(path, "https://cloving.ai");
    query.push(url.searchParams.get("channel"));
    const channel = url.searchParams.get("channel");
    const slot = url.searchParams.get("slot");
    const body =
      channel === "reply"
        ? {
            request_id: "request-1",
            run_id: "run-1",
            delivery_status: "admitted",
          }
        : {
            run_id: "run-1",
            state: "running",
            observed_at: new Date().toISOString(),
          };
    const message = {
      version: 1,
      connectionId: "conn-1",
      direction: "response",
      messageId: "msg-1",
      channel,
      slot,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      body,
    };
    return {
      messages: [
        {
          message_id: "msg-1",
          channel,
          slot,
          ciphertext: await sealMessage(
            daemon,
            keys.agreementPublicKey,
            { connectionId: "conn-1", direction: "response" },
            message,
          ),
        },
      ],
    };
  });
  const run = await zapier.run({ requestId: "request-1" });
  assert.equal(run.state, "running");
  assert.deepEqual(query, ["reply", "state"]);
});

test("a polling trigger reads older pages so bursts do not lose state transitions", async () => {
  const keys = newIdentity();
  const daemon = newIdentity();
  const credential = {
    version: 1,
    origin: "https://cloving.ai",
    connectionId: "conn-1",
    token: "transport-token",
    keys,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  const requests = [];
  const zapier = new Client(credential, async (method, path) => {
    requests.push(path);
    const older = path.includes("before=101");
    const message = {
      version: 1,
      connectionId: "conn-1",
      direction: "response",
      messageId: older ? "event-1" : "event-101",
      channel: "event",
      slot: "slot",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      body: { id: older ? "old" : "new", state: "running" },
    };
    return {
      messages: [
        {
          message_id: message.messageId,
          channel: "event",
          slot: "slot",
          ciphertext: await sealMessage(
            daemon,
            keys.agreementPublicKey,
            { connectionId: "conn-1", direction: "response" },
            message,
          ),
        },
      ],
      next_before: older ? null : 101,
    };
  });
  assert.deepEqual(
    (await zapier.events()).map((event) => event.id),
    ["new", "old"],
  );
  assert.equal(requests.length, 2);
});
