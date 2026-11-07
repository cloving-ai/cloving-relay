import assert from "node:assert/strict";
import { test } from "node:test";
import { newIdentity } from "../dist/identity.js";
import { pairingCode } from "../dist/oauth.js";

test("local OAuth setup sends no private keys and grants no client access before code confirmation", async () => {
  const { prepare, approvePreparation } = await import("../dist/pairing.js");
  const calls = [];
  const { config, setupUrl } = await prepare(
    {
      origin: "https://cloving.ai",
      runtimeDirectory: "/private/local",
      workflows: ["develop"],
      name: "Studio",
    },
    {
      service: async () => ({ ok: true, result: { workflows: ["develop"] } }),
      fields: async () => ({}),
      transport: (token) => async (method, path, body) => {
        calls.push({ token, method, path, body });
        return path.endsWith("/daemons")
          ? { daemon_id: "daemon-1", token: "daemon-token" }
          : { setup_id: "setup-1", claim_code: "claim-code" };
      },
    },
  );
  assert.equal(
    setupUrl,
    "https://cloving.ai/connections/zapier/setup-1?claim_code=claim-code",
  );
  assert.equal(JSON.stringify(calls).includes("PrivateKey"), false);
  assert.equal(JSON.stringify(calls).includes("/private/local"), false);
  assert.equal(
    calls.some((call) => call.path.endsWith("/automation_connections")),
    false,
  );
  assert.equal(calls[0].body.name, "Studio");
  const client = newIdentity();
  const connection = {
    connection_id: "connection-1",
    agreement_public_key: client.agreementPublicKey,
    signing_public_key: client.signingPublicKey,
  };
  const binding = {
    origin: config.origin,
    connectionId: connection.connection_id,
    daemonAgreementPublicKey: config.keys.agreementPublicKey,
    daemonSigningPublicKey: config.keys.signingPublicKey,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
  };
  const code = pairingCode(binding);
  assert.throws(
    () => approvePreparation(config, connection, "0000-0000-0000-0000-0000"),
    /pairing-code-mismatch/,
  );
  const approved = approvePreparation(config, connection, code);
  assert.deepEqual(approved.workflows, ["develop"]);
  assert.equal(approved.clientSigningPublicKey, client.signingPublicKey);
  assert.equal(approved.clientAgreementPublicKey, client.agreementPublicKey);
  assert.equal(approved.keys, config.keys);
  for (const field of Object.keys(binding)) {
    assert.notEqual(
      pairingCode({ ...binding, [field]: `${binding[field]}changed` }),
      code,
    );
  }
  assert.throws(
    () =>
      approvePreparation(
        config,
        { ...connection, signing_public_key: newIdentity().signingPublicKey },
        code,
      ),
    /pairing-code-mismatch/,
  );
});
