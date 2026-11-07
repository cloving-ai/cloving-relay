import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { Store, serviceRequest } from "../../dist/runtime.js";

const execute = promisify(execFile);
const root = resolve("..");
const node26 = process.env.CLOVING_NODE26;
const ruby = process.env.CLOVING_RUBY;
const cli = resolve("dist/mcp-cli.js");

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(5000, undefined, { ref: false }).then(() => child.kill("SIGKILL")),
  ]);
}

test(
  "a stdio MCP harness pairs through OAuth, starts a real local workflow, reads state, and leaves ciphertext only in the Rails relay",
  { timeout: 180000 },
  async () => {
    assert.ok(node26 && ruby, "Set CLOVING_NODE26 and CLOVING_RUBY.");
    const directory = await mkdtemp(join(tmpdir(), "cm-e2e-"));
    const database = join(directory, "relay.sqlite3");
    const env = {
      ...process.env,
      PATH: `${resolve(ruby, "..")}:${process.env.PATH}`,
      RAILS_ENV: "test",
      DATABASE_URL: `sqlite3:${database}`,
      SCHEMA: join(directory, "schema.rb"),
      DISABLE_SPRING: "1",
    };
    const children = [];
    let railsLog = "";
    try {
      await execute(ruby, ["bin/rails", "db:migrate"], {
        cwd: join(root, "cloving-app"),
        env,
        maxBuffer: 10000000,
      });
      await execute(
        ruby,
        [
          "bin/rails",
          "runner",
          'User.create!(email: "mcp-e2e@example.invalid", password: "Mcp-test-password-4829", first_name: "MCP", last_name: "Test", terms_of_service: true, confirmed_at: Time.current)',
        ],
        { cwd: join(root, "cloving-app"), env, maxBuffer: 10000000 },
      );
      const listener = createServer();
      await new Promise((done) => listener.listen(0, "127.0.0.1", done));
      const port = listener.address().port;
      await new Promise((done) => listener.close(done));
      const origin = `http://127.0.0.1:${port}`;
      const rails = spawn(
        ruby,
        [
          "bin/rails",
          "server",
          "--log-to-stdout",
          "-e",
          "test",
          "-b",
          "127.0.0.1",
          "-p",
          String(port),
          "--pid",
          join(directory, "server.pid"),
        ],
        {
          cwd: join(root, "cloving-app"),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(rails);
      rails.stdout.on("data", (chunk) => {
        railsLog += chunk;
      });
      rails.stderr.on("data", (chunk) => {
        railsLog += chunk;
      });
      let ready = false;
      for (let i = 0; i < 150; i++) {
        try {
          ready = (await fetch(`${origin}/up`)).ok;
          if (ready) break;
        } catch {}
        await delay(100);
      }
      assert.ok(ready, "Rails relay did not start");
      const service = spawn(node26, [resolve("test/e2e/service.mjs")], {
        cwd: join(root, "cloving"),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(service);
      let serviceErrors = "";
      service.stderr.on("data", (chunk) => {
        serviceErrors += chunk;
      });
      const [readyLine] = await Promise.race([
        once(service.stdout, "data"),
        once(service, "exit").then(() => {
          throw new Error(
            `Local service exited: ${serviceErrors.slice(-2000)}`,
          );
        }),
        delay(60000, undefined, { ref: false }).then(() => {
          throw new Error("Local service startup timed out");
        }),
      ]);
      const runtime = JSON.parse(readyLine.toString().trim()).runtime;
      const hostState = join(directory, "host");
      const clientState = join(directory, "harness");
      const runHost = async (...args) =>
        execute(process.execPath, [cli, ...args, "--state-dir", hostState], {
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
        });
      const setup = JSON.parse(
        (
          await runHost(
            "connect",
            "mcp",
            "--workflow",
            "develop",
            "--origin",
            origin,
            "--json",
          )
        ).stdout,
      );
      assert.match(setup.setup_url, /\/connections\/mcp\//);
      const cookieJar = new Map();
      const web = async (path, body) => {
        const response = await fetch(`${origin}${path}`, {
          method: body ? "POST" : "GET",
          redirect: "manual",
          headers: {
            cookie: [...cookieJar]
              .map(([key, value]) => `${key}=${value}`)
              .join("; "),
            ...(body
              ? { "content-type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(body ? { body: new URLSearchParams(body) } : {}),
        });
        for (const cookie of response.headers.getSetCookie()) {
          const [key, ...parts] = cookie.split(";")[0].split("=");
          cookieJar.set(key, parts.join("="));
        }
        return response;
      };
      assert.ok(
        [302, 303].includes(
          (
            await web("/users/sign_in", {
              "user[email]": "mcp-e2e@example.invalid",
              "user[password]": "Mcp-test-password-4829",
            })
          ).status,
        ),
      );
      const setupUrl = new URL(setup.setup_url);
      assert.equal(
        (
          await web(setupUrl.pathname, {
            claim_code: setupUrl.searchParams.get("claim_code"),
          })
        ).status,
        200,
      );
      const pairing = spawn(
        process.execPath,
        [
          cli,
          "pair",
          "mcp",
          "--name",
          "studio",
          "--origin",
          origin,
          "--no-open",
          "--state-dir",
          clientState,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(pairing);
      let pairingOutput = "";
      let pairingError = "";
      pairing.stdout.on("data", (chunk) => {
        pairingOutput += chunk;
      });
      pairing.stderr.on("data", (chunk) => {
        pairingError += chunk;
      });
      let authorize;
      for (let i = 0; i < 100; i++) {
        const match = pairingOutput.match(
          /https?:\/\/[^\s]+\/oauth\/mcp\/authorize\?[^\s]+/,
        );
        if (match) {
          authorize = new URL(match[0]);
          break;
        }
        await delay(50);
      }
      assert.ok(
        authorize,
        `Pairing did not print its sign-in link: ${pairingError}`,
      );
      const consent = await web(`${authorize.pathname}${authorize.search}`);
      assert.equal(consent.status, 200);
      assert.match(await consent.text(), /Authorize MCP/);
      const allowed = await web(authorize.pathname, {
        ...Object.fromEntries(authorize.searchParams),
        setup_id: setup.setup_id,
        decision: "allow",
      });
      assert.ok([302, 303].includes(allowed.status));
      const authorizationCode = new URL(
        allowed.headers.get("location"),
      ).searchParams.get("code");
      assert.equal((await fetch(allowed.headers.get("location"))).status, 200);
      if (pairing.exitCode === null) await once(pairing, "close");
      assert.equal(pairing.exitCode, 0, pairingError);
      const credential = await new Store(join(clientState, "clients")).read(
        "studio",
      );
      assert.equal(
        (await stat(join(clientState, "clients", "studio.json"))).mode & 0o777,
        0o600,
      );
      const code = pairingOutput.match(/Pairing code: ([A-F0-9-]+)/)[1];
      await assert.rejects(
        runHost(
          "approve",
          "mcp",
          credential.connectionId,
          "--pairing-code",
          "0000-0000-0000-0000-0000",
          "--json",
        ),
      );
      await runHost(
        "approve",
        "mcp",
        credential.connectionId,
        "--pairing-code",
        code,
        "--json",
      );
      const serving = spawn(
        process.execPath,
        [
          cli,
          "serve",
          "mcp",
          credential.connectionId,
          "--state-dir",
          hostState,
        ],
        {
          env: { ...process.env, CLOVING_RUNTIME_DIR: runtime },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      children.push(serving);
      let servingErrors = "";
      serving.stderr.on("data", (chunk) => {
        servingErrors += chunk;
      });
      const harness = spawn(
        process.execPath,
        [cli, "--connection", "studio", "--state-dir", clientState],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      children.push(harness);
      const answers = new Map();
      const pending = new Map();
      createInterface({ input: harness.stdout }).on("line", (line) => {
        const answer = JSON.parse(line);
        answers.set(answer.id, answer);
        pending.get(answer.id)?.(answer);
        pending.delete(answer.id);
      });
      let count = 0;
      const request = async (method, params = {}) => {
        const id = ++count;
        const response = new Promise((done) => pending.set(id, done));
        harness.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        );
        return Promise.race([
          response,
          delay(40000, undefined, { ref: false }).then(() => {
            throw new Error(`MCP timed out: ${servingErrors}`);
          }),
        ]);
      };
      assert.equal(
        (await request("initialize", { protocolVersion: "2025-11-25" })).result
          .protocolVersion,
        "2025-11-25",
      );
      const modern = {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      };
      const discovered = await request("server/discover", { _meta: modern });
      assert.equal(discovered.result.cacheScope, "private");
      assert.equal(discovered.result.ttlMs, 0);
      assert.equal(
        (await request("tools/list", { _meta: modern })).result.resultType,
        "complete",
      );
      const tools = (await request("tools/list")).result.tools.map(
        (tool) => tool.name,
      );
      assert.ok(tools.includes("cloving_run"));
      assert.ok(!tools.includes("cloving_approve"));
      const call = async (name, args = {}) =>
        (await request("tools/call", { name, arguments: args })).result;
      assert.deepEqual(
        (await call("cloving_workflows")).structuredContent.workflows.map(
          (workflow) => workflow.id,
        ),
        ["develop"],
      );
      const argumentsGiven = {
        workflowId: "develop",
        input: { prompt: "TOP_SECRET_MCP_TASK_82374" },
        commandId: "source-event-one",
      };
      const first = await call("cloving_run", argumentsGiven);
      assert.notEqual(first.isError, true, JSON.stringify(first));
      const runId = first.structuredContent.runId;
      assert.match(runId, /^run-/);
      assert.deepEqual(await call("cloving_run", argumentsGiven), first);
      assert.equal(
        (
          await call("cloving_run", {
            ...argumentsGiven,
            input: { prompt: "different" },
          })
        ).structuredContent.error,
        "conflicting-command",
      );
      const state = (await call("cloving_status", { runId })).structuredContent
        .run;
      assert.equal(state.runId, runId);
      assert.equal(state.workflowId, "develop");
      const local = await serviceRequest(runtime, {
        operation: "status",
        parameters: { runId },
      });
      assert.equal(state.runId, local.result.run.runId);
      assert.notEqual(
        (await call("cloving_questions", { runId })).isError,
        true,
      );
      assert.notEqual(
        (await call("cloving_events", { runId, after: 1 })).isError,
        true,
      );
      assert.equal(
        (
          await call("cloving_run", {
            ...argumentsGiven,
            workflowId: "not-granted",
            commandId: "denied",
          })
        ).structuredContent.error,
        "workflow-not-allowed",
      );
      assert.equal(
        (await call("cloving_approve", {})).structuredContent.error,
        "tool-not-allowed",
      );
      const db = new DatabaseSync(database, { readOnly: true });
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'relay_%'",
        )
        .all();
      const rows = tables.flatMap(({ name }) =>
        db.prepare(`SELECT * FROM "${name}"`).all(),
      );
      assert.ok(rows.length > 0);
      const stored = JSON.stringify(rows);
      for (const secret of [
        "TOP_SECRET_MCP_TASK_82374",
        credential.keys.agreementPrivateKey,
        credential.keys.signingPrivateKey,
        credential.token,
        credential.refreshToken,
        authorizationCode,
      ]) {
        assert.ok(
          !stored.includes(secret),
          "Relay database contains endpoint secrets",
        );
        assert.ok(
          rows.every((row) =>
            Object.values(row).every(
              (value) =>
                !ArrayBuffer.isView(value) ||
                !Buffer.from(
                  value.buffer,
                  value.byteOffset,
                  value.byteLength,
                ).includes(Buffer.from(secret)),
            ),
          ),
          "Relay database BLOB contains endpoint secrets",
        );
        assert.ok(
          !railsLog.includes(secret),
          "Relay process logs contain endpoint secrets",
        );
      }
      db.close();
      await runHost("remove", "mcp", credential.connectionId, "--json");
      assert.equal((await call("cloving_status", { runId })).isError, true);
      harness.stdin.end();
      await stop(harness);
    } finally {
      for (const child of children.toReversed()) await stop(child);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
