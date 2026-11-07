import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../dist/runtime.js";

test("connect explains the browser steps to a person and keeps JSON available explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cz-human-"));
  const service = createServer((socket) =>
    socket.once("data", () =>
      socket.end(
        JSON.stringify({ ok: true, result: { workflows: ["develop"] } }) + "\n",
      ),
    ),
  );
  const relay = createHttpServer((request, response) => {
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url.endsWith("/daemons")
          ? { daemon_id: "daemon-1", token: "private-daemon-token" }
          : { setup_id: "setup-1", claim_code: "claim-1" },
      ),
    );
  });
  try {
    await new Promise((resolve) =>
      service.listen(join(directory, "control.sock"), resolve),
    );
    await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${relay.address().port}`;
    const args = [
      resolve("dist/cli.js"),
      "connect",
      "zapier",
      "--workflow",
      "develop",
      "--runtime-dir",
      directory,
      "--state-dir",
      join(directory, "private"),
      "--origin",
      origin,
      "--no-open",
    ];
    const human = await promisify(execFile)(process.execPath, args);
    assert.match(human.stdout, /Step 2.*Link this computer/i);
    assert.match(human.stdout, /Link computer/);
    assert.match(human.stdout, /automatically/i);
    assert.match(human.stdout, /cloving integrations approve zapier/);
    assert.match(
      human.stdout,
      new RegExp(`${origin}/connections/zapier/setup-1`),
    );
    assert.equal(human.stdout.includes('"setup_id"'), false);
    assert.equal(human.stdout.includes("private-daemon-token"), false);
    const machine = await promisify(execFile)(process.execPath, [
      ...args,
      "--json",
    ]);
    assert.equal(JSON.parse(machine.stdout).setup_id, "setup-1");
  } finally {
    await Promise.all([
      new Promise((resolve) => relay.close(resolve)),
      new Promise((resolve) => service.close(resolve)),
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("connect outside a project explains how to find and start the local Cloving project", async () => {
  const env = { ...process.env };
  delete env.CLOVING_RUNTIME_DIR;
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [resolve("dist/cli.js"), "connect", "zapier"],
      { env },
    ),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /project folder/i);
      assert.match(error.stderr, /cloving start/);
      assert.match(error.stderr, /cloving integrations connect zapier/);
      assert.equal(error.stderr.includes("runtime-directory-required"), false);
      return true;
    },
  );
});

test("bare connect without a terminal requests explicit workflow flags and writes no grant", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cz-selection-"));
  const server = createServer((socket) => {
    socket.once("data", () =>
      socket.end(
        JSON.stringify({ ok: true, result: { workflows: ["develop"] } }) + "\n",
      ),
    );
  });
  try {
    await new Promise((resolve) =>
      server.listen(join(directory, "control.sock"), resolve),
    );
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        resolve("dist/cli.js"),
        "connect",
        "zapier",
        "--runtime-dir",
        directory,
        "--state-dir",
        join(directory, "private"),
      ]),
      (error) =>
        error.code === 1 &&
        error.stderr.includes("Run this command in a terminal"),
    );
    assert.deepEqual(
      await new Store(join(directory, "private", "preparations")).records(),
      [],
    );
    assert.deepEqual(
      await new Store(join(directory, "private", "connections")).records(),
      [],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI approval without the code from Zapier fails before granting local workflow access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cz-approval-"));
  try {
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        resolve("dist/cli.js"),
        "approve",
        "zapier",
        "conn-1",
        "--state-dir",
        directory,
      ]),
      (error) =>
        error.code === 1 && error.stderr.includes("pairing code shown beside"),
    );
    assert.deepEqual(
      await new Store(join(directory, "connections")).records(),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the local CLI lists connection permissions without printing its private keys or tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cz-cli-"));
  try {
    await new Store(join(directory, "connections")).write("conn-1", {
      connectionId: "conn-1",
      workflows: ["develop"],
      daemonToken: "private-token",
      keys: { signingPrivateKey: "private-signing-key" },
    });
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve("dist/cli.js"),
      "list",
      "zapier",
      "--state-dir",
      directory,
      "--json",
    ]);
    assert.deepEqual(JSON.parse(stdout), [
      { connection_id: "conn-1", workflows: ["develop"], revoked: false },
    ]);
    assert.equal(stdout.includes("private-token"), false);
    assert.equal(stdout.includes("private-signing-key"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
