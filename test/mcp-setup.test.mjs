import assert from "node:assert/strict";
import { test } from "node:test";
import { prepare, approvePreparation, pendingCode } from "../dist/pairing.js";
import { newIdentity } from "../dist/identity.js";
import { declarationFields } from "../dist/integration-cli.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("MCP setup uses separate provider links and retains locally selected permissions through approval", async () => {
  const requests = [];
  const prepared = await prepare(
    {
      origin: "https://cloving.ai",
      runtimeDirectory: "/runtime",
      workflows: ["develop"],
      integration: "mcp",
      permissions: ["read", "start", "control"],
    },
    {
      service: async () => ({ ok: true, result: { workflows: ["develop"] } }),
      fields: async () => ({}),
      transport: () => async (method, path, body) => {
        requests.push({ method, path, body });
        return path.endsWith("daemons")
          ? { daemon_id: "daemon", token: "private-daemon-token" }
          : { setup_id: "setup", claim_code: "claim" };
      },
    },
  );
  assert.equal(
    prepared.setupUrl,
    "https://cloving.ai/connections/mcp/setup?claim_code=claim",
  );
  assert.equal(requests[1].body.integration, "mcp");
  const keys = newIdentity();
  const pending = {
    integration: "mcp",
    connection_id: "connection",
    agreement_public_key: keys.agreementPublicKey,
    signing_public_key: keys.signingPublicKey,
  };
  const grant = approvePreparation(
    prepared.config,
    pending,
    pendingCode(prepared.config, pending),
  );
  assert.equal(grant.integration, "mcp");
  assert.deepEqual(grant.permissions, ["read", "start", "control"]);
  assert.throws(
    () =>
      approvePreparation(
        prepared.config,
        { ...pending, integration: "zapier" },
        pendingCode(prepared.config, pending),
      ),
    /connection-invalid/,
  );
});

test("MCP discovery includes integer and boolean input fields while preserving Zapier field behavior", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-fields-"));
  try {
    await mkdir(join(directory, "project"));
    await writeFile(
      join(directory, "project/declarations.json"),
      JSON.stringify([
        {
          workflowId: "develop",
          input: {
            fields: {
              prompt: "string",
              dryRun: { type: "boolean", optional: true },
              retries: { type: "integer", minimum: 1, maximum: 5 },
            },
          },
        },
      ]),
    );
    assert.deepEqual(
      (await declarationFields(join(directory, "run"), "mcp")).develop,
      [
        { key: "prompt", type: "string", required: true },
        { key: "dryRun", type: "boolean", required: false },
        {
          key: "retries",
          type: "integer",
          required: true,
          minimum: 1,
          maximum: 5,
        },
      ],
    );
    assert.deepEqual(
      (await declarationFields(join(directory, "run"))).develop,
      [{ key: "prompt", type: "string", required: true }],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
