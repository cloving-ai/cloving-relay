import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "../dist/identity.js";
import { Client } from "../dist/client.js";
import { createBridge } from "../dist/bridge.js";

test("an encrypted submission is admitted locally, acknowledged, and exposed as a state event", async () => {
  const daemon = newIdentity();
  const client = newIdentity();
  const config = {
    version: 1,
    connectionId: "conn-1",
    origin: "https://cloving.ai",
    runtimeDirectory: "/local/runtime",
    daemonId: "daemon-1",
    daemonToken: "daemon-token",
    keys: daemon,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
    workflows: ["develop"],
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
  const mailbox = [];
  const records = new Map();
  let submissions = 0;
  const transport = async (method, path, body) => {
    const url = new URL(path, config.origin);
    if (method === "POST") {
      mailbox.unshift(body);
      return {};
    }
    if (method === "DELETE") {
      mailbox.splice(
        mailbox.findIndex((m) => m.message_id === path.split("/").at(-1)),
        1,
      );
      return {};
    }
    return {
      messages: mailbox.filter(
        (m) =>
          m.channel === url.searchParams.get("channel") &&
          (!url.searchParams.has("slot") ||
            m.slot === url.searchParams.get("slot")),
      ),
    };
  };
  const store = {
    read: async (key) => records.get(key),
    write: async (key, value) => records.set(key, value),
    records: async () => [...records.entries()],
  };
  const service = async ({ operation }) =>
    operation === "run"
      ? (submissions++, { ok: true, result: { runId: "run-1" } })
      : {
          ok: true,
          result: {
            workflows: ["develop"],
            run: {
              runId: "run-1",
              workflowId: "develop",
              state: "running",
              revision: 2,
            },
          },
        };
  const zapier = new Client(credential, transport);
  const queued = await zapier.start({
    workflowId: "develop",
    requestKey: "event-1",
    input: { prompt: "secret task" },
  });
  const bridge = createBridge(config, {
    transport,
    service,
    store,
    fields: async () => ({}),
    revoked: async () => false,
  });
  await bridge.tick();
  assert.equal(submissions, 1);
  assert.equal(
    mailbox.some((m) => m.channel === "request"),
    false,
  );
  assert.equal(
    (await zapier.run({ requestId: queued.request_id })).state,
    "running",
  );
  assert.equal((await zapier.events()).length, 1);
  assert.equal(JSON.stringify(mailbox).includes("secret task"), false);
  await zapier.start({
    workflowId: "develop",
    requestKey: "event-1",
    input: { prompt: "secret task" },
  });
  await bridge.tick();
  assert.equal(submissions, 1);
});

test("invalid ciphertext is discarded while a temporary local failure retains the following valid request", async () => {
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
  const deletes = [];
  const rows = [
    {
      message_id: "poison",
      channel: "request",
      ciphertext: Buffer.alloc(1105).toString("base64url"),
    },
  ];
  const transport = async (method, path, body) => {
    if (method === "POST") {
      if (body.channel === "request") rows.push(body);
      return {};
    }
    if (method === "DELETE") {
      deletes.push(path);
      rows.splice(
        rows.findIndex((row) => path.endsWith(row.message_id)),
        1,
      );
      return {};
    }
    return { messages: [...rows] };
  };
  let unavailable = true;
  let admitted = 0;
  const service = async ({ operation }) => {
    if (operation === "run") {
      if (unavailable) throw new Error("service-unavailable");
      admitted++;
      return { ok: true, result: { runId: "run-1" } };
    }
    return { ok: true, result: { workflows: ["develop"] } };
  };
  const credential = {
    version: 1,
    origin: "https://cloving.ai",
    connectionId: "conn-1",
    token: "token",
    keys: client,
    daemonAgreementPublicKey: daemon.agreementPublicKey,
    daemonSigningPublicKey: daemon.signingPublicKey,
  };
  await new Client(credential, transport).start({
    workflowId: "develop",
    requestKey: "event-1",
    input: { prompt: "task" },
  });
  const bridge = createBridge(config, {
    transport,
    service,
    store: {
      read: async () => undefined,
      write: async () => {},
      records: async () => [],
    },
    fields: async () => ({}),
    revoked: async () => false,
  });
  await assert.rejects(bridge.tick(), /service-unavailable/);
  assert.equal(deletes.length, 1);
  assert.equal(rows.length, 1);
  unavailable = false;
  await bridge.tick();
  assert.equal(admitted, 1);
  assert.equal(rows.length, 0);
});
