import assert from "node:assert/strict";
import { test } from "node:test";
import { enroll } from "../dist/enrollment.js";
import { Client } from "../dist/client.js";

test("enrollment pins separate endpoint keys and sends no private keys or local paths to the relay", async () => {
  const calls = [];
  const messages = [];
  const transport = (token) => async (method, path, body) => {
    calls.push({ token, method, path, body });
    if (path === "/api/v1/relay/daemons")
      return { daemon_id: "daemon-1", token: "daemon-token" };
    if (path === "/api/v1/relay/automation_connections")
      return { token: "client-token" };
    if (method === "POST") {
      messages.push(body);
      return {};
    }
    return { messages };
  };
  const result = await enroll(
    {
      origin: "https://cloving.ai",
      runtimeDirectory: "/private/local/runtime",
      workflows: ["develop"],
    },
    {
      transport,
      service: async () => ({
        ok: true,
        result: { workflows: ["develop", "private-other-workflow"] },
      }),
      fields: async () => ({
        develop: [{ key: "prompt", type: "string", required: true }],
      }),
    },
  );
  assert.equal(result.config.runtimeDirectory, "/private/local/runtime");
  assert.deepEqual(result.config.workflows, ["develop"]);
  assert.notEqual(
    result.config.keys.signingPrivateKey,
    result.credential.keys.signingPrivateKey,
  );
  assert.equal(
    result.config.clientSigningPublicKey,
    result.credential.keys.signingPublicKey,
  );
  assert.equal(
    result.credential.daemonSigningPublicKey,
    result.config.keys.signingPublicKey,
  );
  assert.equal(JSON.stringify(calls).includes("PrivateKey"), false);
  assert.equal(JSON.stringify(calls).includes("/private/local"), false);
  const client = new Client(result.credential, transport("client-token"));
  const catalog = (await client.read("catalog"))[0];
  assert.deepEqual(
    catalog.workflows.map((entry) => entry.id),
    ["develop"],
  );
  assert.equal(
    JSON.stringify(catalog).includes("private-other-workflow"),
    false,
  );
});
