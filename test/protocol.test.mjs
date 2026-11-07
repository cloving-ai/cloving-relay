import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { sealMessage, openMessage } from "../dist/protocol.js";

function keys() {
  const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const agreement = pair();
  const signing = pair();
  const point = (key) => {
    const jwk = key.export({ format: "jwk" });
    return Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]).toString("base64url");
  };
  return {
    agreementPrivateKey: agreement.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
    agreementPublicKey: point(agreement.publicKey),
    signingPrivateKey: signing.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
    signingPublicKey: point(signing.publicKey),
  };
}

test("a signed workflow request opens only for its pinned recipient and connection", async () => {
  const client = keys();
  const daemon = keys();
  const binding = { connectionId: "connection-1", direction: "request" };
  const message = {
    version: 1,
    connectionId: "connection-1",
    requestId: "request-1",
    operation: "run",
    input: { prompt: "private task" },
  };
  const ciphertext = await sealMessage(
    client,
    daemon.agreementPublicKey,
    binding,
    message,
  );
  assert.equal(
    Buffer.from(ciphertext, "base64url").includes(Buffer.from("private task")),
    false,
  );
  assert.deepEqual(
    await openMessage(daemon, client.signingPublicKey, binding, ciphertext),
    message,
  );
  await assert.rejects(
    openMessage(keys(), client.signingPublicKey, binding, ciphertext),
  );
  await assert.rejects(
    openMessage(daemon, keys().signingPublicKey, binding, ciphertext),
  );
  await assert.rejects(
    openMessage(
      daemon,
      client.signingPublicKey,
      { ...binding, connectionId: "other" },
      ciphertext,
    ),
  );
  await assert.rejects(
    openMessage(
      daemon,
      client.signingPublicKey,
      { ...binding, direction: "response" },
      ciphertext,
    ),
  );
  const altered = Buffer.from(ciphertext, "base64url");
  altered[80] ^= 1;
  await assert.rejects(
    openMessage(
      daemon,
      client.signingPublicKey,
      binding,
      altered.toString("base64url"),
    ),
  );
});
