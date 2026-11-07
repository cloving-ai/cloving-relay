import assert from "node:assert/strict";
import { test } from "node:test";
import { pairMcp, refreshMcpCredential } from "../dist/mcp-auth.js";
import { newIdentity } from "../dist/identity.js";

test("MCP pairing binds the loopback callback to state and PKCE while private keys remain in the harness", async () => {
  const daemon = newIdentity();
  const requests = [];
  let authorization;
  const fetcher = async (url, options) => {
    requests.push({ url, options });
    const body = JSON.parse(options.body);
    assert.equal(body.client_id, "cloving-mcp");
    assert.equal(
      body.redirect_uri,
      authorization.searchParams.get("redirect_uri"),
    );
    assert.equal(body.code_verifier.length >= 43, true);
    return Response.json({
      access_token: "access",
      refresh_token: "refresh",
      connection_id: "connection",
      expires_in: 3600,
      daemon_agreement_public_key: daemon.agreementPublicKey,
      daemon_signing_public_key: daemon.signingPublicKey,
    });
  };
  const credential = await pairMcp("https://cloving.ai", {
    fetcher,
    authorize: async (url) => {
      authorization = new URL(url);
      assert.equal(authorization.pathname, "/oauth/mcp/authorize");
      const callback = new URL(authorization.searchParams.get("redirect_uri"));
      callback.searchParams.set("state", "wrong");
      callback.searchParams.set("code", "authorization-code");
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set(
        "state",
        authorization.searchParams.get("state"),
      );
      assert.equal((await fetch(callback)).status, 200);
    },
  });
  assert.equal(credential.integration, "mcp");
  assert.equal(credential.connectionId, "connection");
  assert.equal(credential.token, "access");
  assert.equal(credential.refreshToken, "refresh");
  assert.ok(
    !JSON.stringify(requests).includes(credential.keys.agreementPrivateKey),
  );
  assert.ok(
    !JSON.stringify(requests).includes(credential.keys.signingPrivateKey),
  );
});

test("MCP refresh retains keys and refuses changed peer keys or connection identity", async () => {
  const peer = newIdentity();
  const credential = {
    version: 1,
    integration: "mcp",
    origin: "https://cloving.ai",
    connectionId: "connection",
    token: "old",
    refreshToken: "refresh",
    expiresAt: 0,
    keys: newIdentity(),
    daemonAgreementPublicKey: peer.agreementPublicKey,
    daemonSigningPublicKey: peer.signingPublicKey,
  };
  const response = {
    access_token: "new",
    refresh_token: "rotated",
    connection_id: "connection",
    expires_in: 3600,
    daemon_agreement_public_key: peer.agreementPublicKey,
    daemon_signing_public_key: peer.signingPublicKey,
  };
  const refreshed = await refreshMcpCredential(credential, async () =>
    Response.json(response),
  );
  assert.deepEqual(refreshed.keys, credential.keys);
  assert.equal(refreshed.token, "new");
  await assert.rejects(
    refreshMcpCredential(credential, async () =>
      Response.json({ ...response, connection_id: "another" }),
    ),
    /oauth-peer-changed/,
  );
  await assert.rejects(
    refreshMcpCredential(credential, async () =>
      Response.json({
        ...response,
        daemon_signing_public_key: newIdentity().signingPublicKey,
      }),
    ),
    /oauth-peer-changed/,
  );
});
