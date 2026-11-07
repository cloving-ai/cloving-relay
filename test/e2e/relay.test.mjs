import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import app from "../../dist/index.js";
import { parseCredential, httpTransport } from "../../dist/http.js";
import { Client } from "../../dist/client.js";
import { pairingCode } from "../../dist/oauth.js";
import { Store } from "../../dist/runtime.js";
import { terminalConnect } from "./terminal.mjs";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const root = resolve("..");
const node26 = process.env.CLOVING_NODE26;
const ruby = process.env.CLOVING_RUBY;

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const number = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return number;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    closed,
    delay(10000, undefined, { ref: false }).then(() => {
      child.kill("SIGKILL");
    }),
  ]);
}

test(
  "Zapier actions cross the real Rails relay into a real local Cloving service with ciphertext-only storage",
  { timeout: 90000 },
  async () => {
    assert.ok(
      node26 && ruby,
      "Set CLOVING_NODE26 and CLOVING_RUBY to the required executable paths.",
    );
    const directory = await mkdtemp(join(tmpdir(), "cz-e2e-"));
    const database = join(directory, "relay.sqlite3");
    const environment = {
      ...process.env,
      RAILS_ENV: "test",
      DATABASE_URL: `sqlite3:${database}`,
      SCHEMA: join(directory, "schema.rb"),
      DISABLE_SPRING: "1",
    };
    let rails;
    let service;
    let logs = "";
    try {
      await execute(ruby, ["bin/rails", "db:migrate"], {
        cwd: join(root, "cloving-app"),
        env: environment,
        maxBuffer: 10000000,
      });
      await execute(
        ruby,
        [
          "bin/rails",
          "runner",
          'User.create!(email: "zapier-e2e@example.invalid", password: "E2e-test-password-4829", first_name: "Zapier", last_name: "Test", terms_of_service: true, confirmed_at: Time.current)',
        ],
        {
          cwd: join(root, "cloving-app"),
          env: environment,
          maxBuffer: 10000000,
        },
      );
      const listen = await port();
      const origin = `http://127.0.0.1:${listen}`;
      rails = spawn(
        ruby,
        [
          "bin/rails",
          "server",
          "-e",
          "test",
          "-b",
          "127.0.0.1",
          "-p",
          String(listen),
          "--pid",
          join(directory, "server.pid"),
        ],
        {
          cwd: join(root, "cloving-app"),
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      rails.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      rails.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      let ready = false;
      for (let count = 0; count < 100; count++) {
        try {
          await fetch(`${origin}/up`);
          ready = true;
          break;
        } catch {
          await delay(100);
        }
      }
      assert.ok(ready, logs.slice(-5000));
      service = spawn(node26, [resolve("test/e2e/service.mjs")], {
        cwd: join(root, "cloving"),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      service.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      const [readyLine] = await Promise.race([
        once(service.stdout, "data"),
        once(service, "exit").then(() => {
          throw new Error(logs.slice(-6000));
        }),
        delay(45000, undefined, { ref: false }).then(() => {
          throw new Error(`Cloving startup timed out: ${logs.slice(-6000)}`);
        }),
      ]);
      const runtime = JSON.parse(readyLine.toString().trim()).runtime;
      const stateDirectory = join(directory, "connections-private");
      const runCli = async (...args) =>
        execute(
          process.execPath,
          [resolve("dist/cli.js"), ...args, "--state-dir", stateDirectory],
          { env: { ...process.env, CLOVING_RUNTIME_DIR: runtime } },
        );
      const bin = join(directory, "bin");
      await mkdir(bin);
      await writeFile(
        join(bin, "cloving-zapier"),
        `#!${process.execPath}\nimport(${JSON.stringify(pathToFileURL(resolve("dist/cli.js")).href)});\n`,
        { mode: 0o700 },
      );
      const terminal = await terminalConnect(
        node26,
        [
          join(root, "cloving", "src", "cli.ts"),
          "integrations",
          "connect",
          "zapier",
          "--no-open",
          "--origin",
          origin,
          "--state-dir",
          stateDirectory,
        ],
        {
          ...process.env,
          CLOVING_RUNTIME_DIR: runtime,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      );
      assert.match(terminal, /\[x\] develop/);
      assert.match(terminal, /Step 2 of 3: Link this computer/);
      assert.match(terminal, /cloving integrations approve zapier/);
      const setupLink = terminal.match(
        /https?:\/\/[^\s]+\/connections\/zapier\/[A-Za-z0-9_-]+\?claim_code=[A-Za-z0-9_-]+/,
      )[0];
      const connected = {
        setup_url: setupLink,
        setup_id: new URL(setupLink).pathname.split("/").at(-1),
      };
      const prepared = await new Store(
        join(stateDirectory, "preparations"),
      ).records();
      assert.deepEqual(prepared[0][1].workflows, ["develop"]);
      assert.equal(connected.credential_file, undefined);
      const setupUrl = new URL(connected.setup_url);
      let cookies = "";
      const web = async (path, data) => {
        const response = await fetch(`${origin}${path}`, {
          method: data ? "POST" : "GET",
          redirect: "manual",
          headers: {
            cookie: cookies,
            ...(data
              ? { "content-type": "application/x-www-form-urlencoded" }
              : {}),
          },
          ...(data ? { body: new URLSearchParams(data) } : {}),
        });
        const fresh = response.headers.getSetCookie();
        if (fresh.length)
          cookies = fresh.map((value) => value.split(";")[0]).join("; ");
        return response;
      };
      const signedIn = await web("/users/sign_in", {
        "user[email]": "zapier-e2e@example.invalid",
        "user[password]": "E2e-test-password-4829",
      });
      assert.ok([302, 303].includes(signedIn.status));
      const linked = await web(setupUrl.pathname, {
        claim_code: setupUrl.searchParams.get("claim_code"),
      });
      assert.equal(linked.status, 200);
      assert.match(await linked.text(), /Your computer is linked/);
      const verifier = "v".repeat(43);
      const redirect =
        "https://zapier.com/dashboard/auth/oauth/return/App249365CLIAPI/";
      const allowed = await web("/oauth/zapier/authorize", {
        client_id: "cloving-zapier",
        redirect_uri: redirect,
        response_type: "code",
        scope: "workflow:start workflow:read",
        state: "e2e-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        setup_id: connected.setup_id,
        decision: "allow",
      });
      assert.ok([302, 303].includes(allowed.status));
      const callback = new URL(allowed.headers.get("location"));
      assert.equal(callback.searchParams.get("state"), "e2e-state");
      const z = {
        request: async (options) => {
          const response = await fetch(
            options.url.replace("https://cloving.ai", origin),
            {
              method: options.method,
              headers: options.headers,
              ...(options.body
                ? {
                    body:
                      typeof options.body === "string"
                        ? options.body
                        : JSON.stringify(options.body),
                  }
                : {}),
            },
          );
          const data = await response.json();
          return {
            status: response.status,
            data,
            throwForStatus() {
              assert.ok(response.ok, JSON.stringify(data));
            },
          };
        },
      };
      const oauth = await app.authentication.oauth2Config.getAccessToken(z, {
        inputData: {
          code: callback.searchParams.get("code"),
          code_verifier: verifier,
          redirect_uri: redirect,
        },
        authData: {},
      });
      const localCredential = { ...parseCredential(oauth.credential), origin };
      const credentialText = Buffer.from(
        JSON.stringify(localCredential),
      ).toString("base64url");
      const credential = { ...localCredential, token: oauth.access_token };
      const client = new Client(
        credential,
        httpTransport(origin, credential.token),
      );
      const code = pairingCode({
        origin,
        connectionId: credential.connectionId,
        daemonAgreementPublicKey: credential.daemonAgreementPublicKey,
        daemonSigningPublicKey: credential.daemonSigningPublicKey,
        clientAgreementPublicKey: credential.keys.agreementPublicKey,
        clientSigningPublicKey: credential.keys.signingPublicKey,
      });
      await assert.rejects(
        runCli(
          "approve",
          "zapier",
          credential.connectionId,
          "--pairing-code",
          "0000-0000-0000-0000-0000",
        ),
      );
      const approval = await terminalConnect(
        node26,
        [
          join(root, "cloving", "src", "cli.ts"),
          "integrations",
          "approve",
          "zapier",
          "--state-dir",
          stateDirectory,
        ],
        {
          ...process.env,
          CLOVING_RUNTIME_DIR: runtime,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
        code,
      );
      assert.match(approval, /Zapier is approved for develop/);
      assert.match(approval, /cloving integrations serve zapier/);
      const bundle = {
        authData: { ...oauth, credential: credentialText },
        inputData: {
          workflow_id: "develop",
          request_key: "source-event-1",
          input_json: '{"prompt":"TOP_SECRET_ZAPIER_TASK_7824"}',
        },
      };
      await app.authentication.test(z, bundle);
      const queued = await app.creates.start_workflow.operation.perform(
        z,
        bundle,
      );
      assert.equal(queued.delivery_status, "queued");
      await runCli("serve", "zapier", "--once");
      let run = await client.run({ requestId: queued.request_id });
      assert.equal(run.delivery_status, "admitted");
      assert.match(run.run_id, /^run-/);
      assert.equal(typeof run.state, "string");
      for (
        let attempt = 0;
        attempt < 30 && run.state !== "completed";
        attempt++
      ) {
        await delay(100);
        await runCli("serve", "zapier", "--once");
        run = await client.run({ requestId: queued.request_id });
      }
      assert.equal(run.state, "completed");
      const initialEvents = (await client.events()).length;
      assert.ok(initialEvents >= 1);
      await app.creates.start_workflow.operation.perform(z, bundle);
      await runCli("serve", "zapier", "--once");
      assert.equal(
        (await client.run({ requestId: queued.request_id })).run_id,
        run.run_id,
      );
      assert.equal((await client.events()).length, initialEvents);
      const denied = await client.start({
        workflowId: "not-granted",
        requestKey: "denied-1",
        input: {},
      });
      await runCli("serve", "zapier", "--once");
      assert.equal(
        (await client.run({ requestId: denied.request_id })).error,
        "workflow-not-allowed",
      );
      const db = new DatabaseSync(database, { readOnly: true });
      const messages = db
        .prepare("SELECT ciphertext FROM relay_automation_messages")
        .all();
      const connections = db
        .prepare("SELECT * FROM relay_automation_connections")
        .all();
      assert.ok(messages.length > 0);
      assert.equal(
        messages.some((row) =>
          Buffer.from(row.ciphertext).includes(
            Buffer.from("TOP_SECRET_ZAPIER_TASK_7824"),
          ),
        ),
        false,
      );
      assert.equal(
        JSON.stringify(connections).includes(
          credential.keys.agreementPrivateKey,
        ),
        false,
      );
      assert.equal(
        JSON.stringify(connections).includes(credential.token),
        false,
      );
      db.close();
      await runCli("remove", "zapier", credential.connectionId);
      await assert.rejects(client.events(), /relay-status-401/);
    } finally {
      await stop(service);
      await stop(rails);
      await rm(directory, { recursive: true, force: true });
    }
  },
);
