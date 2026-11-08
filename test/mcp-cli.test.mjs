import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

const execute = promisify(execFile);

test("the MCP executable explains both computer setup and harness pairing without requiring a project", async () => {
  const result = await execute(process.execPath, [
    resolve("dist/mcp-cli.js"),
    "--help",
  ]);
  assert.match(result.stdout, /integrations connect mcp/);
  assert.match(result.stdout, /integrations pair mcp/);
  assert.match(result.stdout, /--connection/);
  assert.match(result.stdout, /--allow-approvals/);
});

test("an unknown MCP client connection gives an actionable error on stderr and leaves stdout empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-cli-"));
  try {
    await assert.rejects(
      execute(process.execPath, [
        resolve("dist/mcp-cli.js"),
        "--connection",
        "unknown",
        "--state-dir",
        directory,
      ]),
      (error) => {
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /cloving integrations pair mcp/);
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated harness configuration preserves its Node runtime and credential directory outside the pairing environment", async () => {
  const { newIdentity } = await import("../dist/identity.js");
  const { Store } = await import("../dist/runtime.js");
  const directory = await mkdtemp(join(tmpdir(), "mcp-config-"));
  try {
    await writeFile(join(directory, "cloving-mcp"), "#!/bin/sh\nexit 97\n", {
      mode: 0o755,
    });
    const pairingDirectory = join(directory, "pairing");
    const harnessDirectory = join(directory, "harness");
    await mkdir(pairingDirectory);
    await mkdir(harnessDirectory);
    const stateDirectory = join(pairingDirectory, "private client state");
    const peer = newIdentity();
    await new Store(join(stateDirectory, "clients")).write("studio", {
      version: 1,
      integration: "mcp",
      origin: "https://cloving.ai",
      connectionId: "config-check",
      token: "unused-synthetic-token",
      refreshToken: "unused-synthetic-refresh",
      expiresAt: Date.now() + 3600000,
      keys: newIdentity(),
      daemonAgreementPublicKey: peer.agreementPublicKey,
      daemonSigningPublicKey: peer.signingPublicKey,
    });
    const configured = await execute(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { mcpHarnessConfiguration } from ${JSON.stringify(pathToFileURL(resolve("dist/integration-cli.js")).href)};
       process.stdout.write(JSON.stringify(mcpHarnessConfiguration(${JSON.stringify({ name: "studio", nodePath: process.execPath, entrypoint: resolve("dist/mcp-cli.js"), stateDirectory: "private client state" })})));`,
      ],
      { cwd: pairingDirectory },
    );
    const config = JSON.parse(configured.stdout).mcpServers.cloving;
    const input =
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    const child = execFile(config.command, config.args, {
      cwd: harnessDirectory,
      env: { ...process.env, PATH: directory, CLOVING_MCP_STATE_DIR: "" },
    });
    let output = "",
      errors = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (errors += chunk));
    child.stdin.end(input);
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, errors);
    assert.deepEqual(JSON.parse(output), { jsonrpc: "2.0", id: 1, result: {} });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
