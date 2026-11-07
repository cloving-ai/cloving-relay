import assert from "node:assert/strict";
import { test } from "node:test";
import app from "../dist/index.js";
import { newIdentity } from "../dist/identity.js";
import { parseCredential } from "../dist/http.js";

test("Zapier connects with PKCE OAuth through cloving.ai and asks for no pasted credential", () => {
  assert.equal(app.authentication.type, "oauth2");
  assert.equal(app.authentication.oauth2Config.enablePkce, true);
  assert.equal(app.authentication.oauth2Config.autoRefresh, true);
  assert.equal(
    app.authentication.fields.every((field) => field.computed),
    true,
  );
  assert.equal(
    app.authentication.oauth2Config.authorizeUrl.url,
    "https://cloving.ai/oauth/zapier/authorize",
  );
});

test("OAuth exchange generates private client keys inside Zapier and sends only public keys to the relay", async () => {
  const daemon = newIdentity();
  const requests = [];
  const z = {
    request: async (request) => {
      requests.push(request);
      return {
        throwForStatus() {},
        data: {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 3600,
          token_type: "Bearer",
          connection_id: "connection-1",
          connection_name: "Test computer",
          daemon_agreement_public_key: daemon.agreementPublicKey,
          daemon_signing_public_key: daemon.signingPublicKey,
        },
      };
    },
  };
  const result = await app.authentication.oauth2Config.getAccessToken(z, {
    inputData: {
      code: "code-1",
      code_verifier: "v".repeat(43),
      redirect_uri:
        "https://zapier.com/dashboard/auth/oauth/return/App249365CLIAPI/",
    },
    authData: {},
  });
  const credential = parseCredential(result.credential);
  assert.equal(result.access_token, "access-1");
  assert.equal(
    credential.keys.agreementPublicKey,
    requests[0].body.agreement_public_key,
  );
  assert.equal(
    credential.keys.signingPublicKey,
    requests[0].body.signing_public_key,
  );
  assert.equal(credential.daemonAgreementPublicKey, daemon.agreementPublicKey);
  assert.match(result.pairing_code, /^(?:[A-F0-9]{4}-){4}[A-F0-9]{4}$/);
  assert.equal(requests[0].body.code_verifier, "v".repeat(43));
  assert.equal(requests[0].body.grant_type, "authorization_code");
  assert.equal(
    JSON.stringify(requests).includes(credential.keys.signingPrivateKey),
    false,
  );
  assert.equal(
    JSON.stringify(requests).includes(credential.keys.agreementPrivateKey),
    false,
  );

  const refreshed = await app.authentication.oauth2Config.refreshAccessToken(
    z,
    { authData: result, inputData: {} },
  );
  assert.equal(refreshed.credential, result.credential);
  assert.equal(refreshed.pairing_code, result.pairing_code);
  assert.deepEqual(requests[1].body, {
    grant_type: "refresh_token",
    client_id: "cloving-zapier",
    refresh_token: "refresh-1",
  });
});
