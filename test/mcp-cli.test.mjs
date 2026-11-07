import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
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
