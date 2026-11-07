import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../dist/index.js";
import { newIdentity } from "../dist/identity.js";
import { sealMessage } from "../dist/protocol.js";

test("the Zapier app authenticates with a signed catalog and encrypts Start Workflow inputs", async () => {
  const keys = newIdentity();
  const daemon = newIdentity();
  const credential = Buffer.from(
    JSON.stringify({
      version: 1,
      connectionId: "conn-1",
      origin: "https://cloving.ai",
      token: "client-token",
      keys,
      daemonAgreementPublicKey: daemon.agreementPublicKey,
      daemonSigningPublicKey: daemon.signingPublicKey,
    }),
  ).toString("base64url");
  const calls = [];
  const now = Date.now();
  const catalog = {
    version: 1,
    connectionId: "conn-1",
    direction: "response",
    messageId: "catalog-1",
    channel: "catalog",
    slot: "catalog",
    issuedAt: now,
    expiresAt: now + 60000,
    body: {
      workflows: [
        {
          id: "develop",
          name: "develop",
          inputFields: [{ key: "prompt", type: "string", required: true }],
        },
      ],
    },
  };
  const ciphertext = await sealMessage(
    daemon,
    keys.agreementPublicKey,
    { connectionId: "conn-1", direction: "response" },
    catalog,
  );
  const z = {
    request: async (request) => {
      calls.push(request);
      return {
        status: 200,
        throwForStatus() {},
        data: request.url.includes("messages?")
          ? {
              messages: [
                {
                  message_id: "catalog-1",
                  channel: "catalog",
                  slot: "catalog",
                  ciphertext,
                },
              ],
            }
          : {},
      };
    },
  };
  const bundle = {
    authData: { credential },
    inputData: {
      workflow_id: "develop",
      request_key: "source-123",
      input_json: '{"prompt":"sensitive task"}',
    },
  };
  assert.equal(
    (await app.authentication.test(z, bundle)).connection_id,
    "conn-1",
  );
  assert.deepEqual(
    (await app.triggers.workflows.operation.perform(z, bundle)).map(
      (row) => row.id,
    ),
    ["develop"],
  );
  const result = await app.creates.start_workflow.operation.perform(z, bundle);
  assert.equal(result.delivery_status, "queued");
  assert.equal(JSON.stringify(calls).includes("sensitive task"), false);
  assert.equal(JSON.stringify(calls).includes(credential), false);
  assert.ok(
    calls.every((call) => call.headers.Authorization === "Bearer client-token"),
  );
});
