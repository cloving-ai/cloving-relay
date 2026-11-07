import assert from "node:assert/strict";
import { test } from "node:test";
import { relayOrigin, httpTransport, parseCredential } from "../dist/http.js";

test("relay credentials cannot be sent to plaintext remote URLs or a redirected origin", async () => {
  for (const url of [
    "http://cloving.ai",
    "https://user:pass@cloving.ai",
    "https://cloving.ai/path",
    "https://cloving.ai?secret=1",
  ])
    assert.throws(() => relayOrigin(url), /relay-origin-invalid/);
  assert.equal(relayOrigin("http://127.0.0.1:3456"), "http://127.0.0.1:3456");
  let options;
  const transport = httpTransport(
    "https://cloving.ai",
    "only-this-token",
    async (url, request) => {
      options = request;
      return new Response("{}", { status: 201 });
    },
  );
  await transport("POST", "/api/v1/relay/daemons", { opaque: true });
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.authorization, "Bearer only-this-token");
  await assert.rejects(
    transport("GET", "https://evil.example/"),
    /relay-path-invalid/,
  );
  assert.throws(
    () => parseCredential("not-a-credential"),
    /credential-invalid/,
  );
});
