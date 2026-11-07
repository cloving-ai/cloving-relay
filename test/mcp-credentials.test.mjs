import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { newIdentity } from "../dist/identity.js";
import { Store } from "../dist/runtime.js";
import {
  credentialTransport,
  unpairMcpCredential,
} from "../dist/mcp-credentials.js";

test("two harness processes sharing a connection rotate once and reload the new private credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-creds-"));
  const daemon = newIdentity();
  let rotations = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/oauth/mcp/token") {
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.equal(JSON.parse(body).refresh_token, "old-refresh");
      rotations++;
      await new Promise((done) => setTimeout(done, 500));
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          connection_id: "connection",
          daemon_agreement_public_key: daemon.agreementPublicKey,
          daemon_signing_public_key: daemon.signingPublicKey,
        }),
      );
    } else {
      assert.equal(request.headers.authorization, "Bearer new-access");
      response.end("{}");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const store = new Store(directory);
  try {
    await store.write("studio", {
      version: 1,
      integration: "mcp",
      origin: `http://127.0.0.1:${server.address().port}`,
      connectionId: "connection",
      token: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      keys: newIdentity(),
      daemonAgreementPublicKey: daemon.agreementPublicKey,
      daemonSigningPublicKey: daemon.signingPublicKey,
    });
    const source = `import {Store} from ${JSON.stringify(resolve("dist/runtime.js"))}; import {credentialTransport} from ${JSON.stringify(resolve("dist/mcp-credentials.js"))}; const access=await credentialTransport(new Store(${JSON.stringify(directory)}),'studio'); await access.transport('GET','/api/v1/relay/automation_connections/connection');`;
    const first = promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      source,
    ]);
    for (let i = 0; i < 100 && rotations === 0; i++)
      await new Promise((done) => setTimeout(done, 5));
    await Promise.all([
      first,
      promisify(execFile)(process.execPath, [
        "--input-type=module",
        "-e",
        source,
      ]),
    ]);
    assert.equal(rotations, 1);
    assert.equal((await store.read("studio")).refreshToken, "new-refresh");
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
});

test("a lost refresh outcome is persisted and requires explicit re-pairing without replaying the old refresh token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-creds-"));
  const store = new Store(directory);
  const daemon = newIdentity();
  try {
    await store.write("studio", {
      version: 1,
      integration: "mcp",
      origin: "https://cloving.ai",
      connectionId: "connection",
      token: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      keys: newIdentity(),
      daemonAgreementPublicKey: daemon.agreementPublicKey,
      daemonSigningPublicKey: daemon.signingPublicKey,
    });
    let calls = 0;
    const first = await credentialTransport(store, "studio", async () => {
      calls++;
      throw new Error("network outcome unknown");
    });
    await assert.rejects(
      first.transport("GET", "/api/v1/relay/automation_connections/connection"),
    );
    const next = await credentialTransport(store, "studio", async () => {
      calls++;
      throw new Error("must not replay");
    });
    await assert.rejects(
      next.transport("GET", "/api/v1/relay/automation_connections/connection"),
      /oauth-refresh-outcome-unknown/,
    );
    assert.equal(calls, 1);
    assert.equal((await store.read("studio")).refreshPending, true);
    await unpairMcpCredential(store, "studio", async (url, options) => {
      assert.equal(url, "https://cloving.ai/oauth/mcp/revoke");
      assert.equal(JSON.parse(options.body).token, "old-access");
      return new Response(null, { status: 200 });
    });
    assert.equal(await store.read("studio"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
