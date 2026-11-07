import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { newIdentity } from "../../dist/identity.js";
import { openMessage, sealMessage } from "../../dist/protocol.js";

test("Node 22 HPKE exchanges signed messages with Cloving's native Node 26 encryption", async () => {
  assert.ok(
    process.env.CLOVING_NODE26,
    "Set CLOVING_NODE26 to the Node 26 executable path.",
  );
  const daemon = newIdentity();
  const client = newIdentity();
  const binding = { connectionId: "interop", direction: "request" };
  const message = {
    version: 1,
    body: { prompt: "synthetic interoperability fixture" },
  };
  const ciphertext = await sealMessage(
    client,
    daemon.agreementPublicKey,
    binding,
    message,
  );
  const source = `import {openFrom,sealTo} from ${JSON.stringify(join(resolve("../cloving"), "src/relay/hpke.ts"))};
import {createPrivateKey,sign} from 'node:crypto';
let text='';for await(const part of process.stdin)text+=part;
const value=JSON.parse(text);const info=Buffer.from('cloving-automation-v1');const aad=Buffer.from('cloving-automation-v1|interop|request');
const padded=openFrom(value.daemon.agreementPrivateKey,{info,aad,sealed:Buffer.from(value.ciphertext,'base64url')});
const end=padded.findLastIndex(byte=>byte!==0);const signed=JSON.parse(padded.subarray(0,end).toString());
const signature=sign('sha256',Buffer.from(signed.payload),{key:createPrivateKey({key:Buffer.from(value.daemon.signingPrivateKey,'base64url'),format:'der',type:'pkcs8'}),dsaEncoding:'ieee-p1363'}).toString('base64url');
const plaintext=Buffer.from(JSON.stringify({payload:signed.payload,signature}));const response=Buffer.alloc(1024);plaintext.copy(response);response[plaintext.length]=128;
const sealed=sealTo(value.client.agreementPublicKey,{info,aad:Buffer.from('cloving-automation-v1|interop|response'),plaintext:response});
process.stdout.write(JSON.stringify({message:JSON.parse(signed.payload),ciphertext:sealed.toString('base64url')}));`;
  const child = spawn(
    process.env.CLOVING_NODE26,
    ["--input-type=module", "-e", source],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdin.end(JSON.stringify({ daemon, client, ciphertext }));
  const [status] = await once(child, "close");
  assert.equal(status, 0, errors);
  const reply = JSON.parse(output);
  assert.deepEqual(reply.message, message);
  assert.deepEqual(
    await openMessage(
      client,
      daemon.signingPublicKey,
      { connectionId: "interop", direction: "response" },
      reply.ciphertext,
    ),
    message,
  );
});
