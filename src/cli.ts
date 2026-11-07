#!/usr/bin/env node
import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ConnectionConfig } from "./enrollment.js";
import {
  prepare,
  approvePreparation,
  publishCatalog,
  type PreparationConfig,
} from "./pairing.js";
import { Store, serviceRequest } from "./runtime.js";
import { httpTransport, relayOrigin } from "./http.js";
import { createBridge } from "./bridge.js";
import { object } from "./local.js";
import { selectWorkflows } from "./selection.js";
import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";

async function answer(question: string): Promise<string> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const stop = new AbortController();
  const cancel = () => stop.abort();
  terminal.once("SIGINT", cancel);
  try {
    return await terminal.question(question, { signal: stop.signal });
  } catch {
    throw new Error("workflow-selection-cancelled");
  } finally {
    terminal.close();
  }
}

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "explorer.exe"
        : "xdg-open";
  return new Promise((resolve) =>
    execFile(command, [url], { timeout: 5000 }, (error) => resolve(!error)),
  );
}

async function declarationFields(
  runtime: string,
): Promise<Record<string, unknown>> {
  let declarations: unknown;
  try {
    declarations = JSON.parse(
      await readFile(
        join(dirname(runtime), "project", "declarations.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (object(error).code === "ENOENT") return {};
    throw error;
  }
  if (!Array.isArray(declarations)) return {};
  return Object.fromEntries(
    declarations.map(object).map((declaration) => [
      String(declaration.workflowId),
      Object.entries(object(object(declaration.input).fields)).flatMap(
        ([key, rule]) => {
          const field = object(rule);
          return rule === "string" ||
            field.type === "string" ||
            field.type === "ticket"
            ? [{ key, type: "string", required: field.optional !== true }]
            : [];
        },
      ),
    ]),
  );
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      workflow: { type: "string", multiple: true },
      name: { type: "string" },
      "no-open": { type: "boolean" },
      "pairing-code": { type: "string" },
      "state-dir": { type: "string" },
      "runtime-dir": { type: "string" },
      origin: { type: "string" },
      repository: { type: "string" },
      json: { type: "boolean" },
      once: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  const [command, integration, connectionId] = positionals;
  if (values.help || command === undefined) {
    process.stdout.write(
      "Usage: cloving integrations connect zapier [--workflow WORKFLOW]\n       cloving integrations approve zapier [CONNECTION_ID --pairing-code CODE]\n       cloving integrations serve zapier [CONNECTION_ID]\n       cloving integrations list zapier [--json]\n       cloving integrations remove zapier CONNECTION_ID\nConnect guides you through workflow selection and opens the browser to link your computer. All workflows are selected initially. Use --workflow repeatedly for noninteractive selection.\nApprove asks for the pairing code shown in Zapier. Serve keeps the encrypted connection running.\nUse --json for structured output, --no-open to open setup links yourself, --origin for a self-hosted relay, and --state-dir for private connection storage.\n",
    );
    return;
  }
  if (
    integration !== "zapier" ||
    !["connect", "approve", "serve", "list", "remove"].includes(command)
  )
    throw new Error("usage-error");
  const runtime = values["runtime-dir"] ?? process.env.CLOVING_RUNTIME_DIR;
  const directory =
    values["state-dir"] ??
    (runtime
      ? join(dirname(runtime), "state", "zapier")
      : join(homedir(), ".local", "state", "cloving-zapier"));
  const connections = new Store(join(directory, "connections"));
  const preparations = new Store(join(directory, "preparations"));
  const preparedConnections = async (config: PreparationConfig) => {
    const response = object(
      await httpTransport(config.origin, config.daemonToken)(
        "GET",
        "/api/v1/relay/automation_connections",
      ),
    );
    if (!Array.isArray(response.connections))
      throw new Error("relay-response-invalid");
    return response.connections.map(object);
  };
  if (command === "list") {
    const rows: Record<string, unknown>[] = (await connections.records()).map(
      ([, config]) => ({
        connection_id: config.connectionId,
        workflows: config.workflows,
        revoked: Boolean(config.revokedAt),
      }),
    );
    for (const [, value] of await preparations.records()) {
      const config = value as unknown as PreparationConfig;
      for (const pending of await preparedConnections(config)) {
        if (!rows.some((row) => row.connection_id === pending.connection_id)) {
          rows.push({
            connection_id: pending.connection_id,
            workflows: config.workflows,
            revoked: false,
            state: "awaiting-local-approval",
          });
        }
      }
    }
    if (values.json) process.stdout.write(JSON.stringify(rows) + "\n");
    else {
      process.stdout.write(
        rows.length
          ? "Zapier connections for this project:\n\n"
          : "This project has no Zapier connections yet.\nRun cloving integrations connect zapier to get started.\n",
      );
      for (const row of rows)
        process.stdout.write(
          `  ${row.revoked ? "Removed" : row.state ? "Waiting for your approval" : "Approved"} · ${row.connection_id}\n  Workflows: ${Array.isArray(row.workflows) ? row.workflows.join(", ") : ""}\n\n`,
        );
      if (rows.some((row) => row.state))
        process.stdout.write(
          "To finish, run cloving integrations approve zapier. It will ask for the pairing code shown in Zapier.\n",
        );
    }
    return;
  }
  if (command === "connect") {
    if (!runtime) throw new Error("runtime-directory-required");
    const origin = relayOrigin(values.origin ?? "https://cloving.ai");
    if (!values.json)
      process.stdout.write(
        "Connect this Cloving project to Zapier\n\nStep 1 of 3: Choose the workflows Zapier can use.\n" +
          (values.workflow === undefined
            ? "Press Enter to connect all selected workflows, or use arrows and Space to change them.\n\n"
            : "Using the workflows you specified with --workflow.\n"),
      );
    let workflows = values.workflow;
    if (workflows === undefined) {
      const status = await serviceRequest(runtime, {
        operation: "status",
        parameters: { limit: 1 },
      });
      const available = object(status.result).workflows;
      if (
        status.ok !== true ||
        !Array.isArray(available) ||
        !available.every((id) => typeof id === "string")
      )
        throw new Error("service-unavailable");
      workflows = await selectWorkflows(available);
    }
    const result = await prepare(
      {
        origin,
        runtimeDirectory: runtime,
        workflows,
        ...(values.name ? { name: values.name } : {}),
      },
      {
        service: (request) => serviceRequest(runtime, request),
        transport: (token) => httpTransport(origin, token),
        fields: () => declarationFields(runtime),
      },
    );
    await preparations.write(result.config.setupId, result.config);
    if (values.json)
      process.stdout.write(
        JSON.stringify({
          setup_id: result.config.setupId,
          setup_url: result.setupUrl,
          next: "Open setup_url to link this computer, then choose Sign in with Cloving in Zapier. Run cloving integrations list zapier and approve the connection using the pairing code shown by Zapier.",
        }) + "\n",
      );
    else {
      process.stdout.write(
        `\nSelected ${result.config.workflows.length} workflow${result.config.workflows.length === 1 ? "" : "s"}: ${result.config.workflows.join(", ")}\n\nStep 2 of 3: Link this computer to your Cloving account.\n\n  ${result.setupUrl}\n\n`,
      );
      if (!values["no-open"] && process.stdin.isTTY) {
        const opened = await openBrowser(result.setupUrl);
        process.stdout.write(
          opened
            ? "The setup page is open in your browser.\n"
            : "Open the link above in your browser.\n",
        );
      } else process.stdout.write("Open the link above in your browser.\n");
      process.stdout.write(
        "Sign in if asked, then click Link computer. The Zapier window will update automatically.\nIn that window, choose your computer and click Authorize Zapier.\n\nStep 3 of 3: Approve Zapier on this computer.\nOnce Zapier shows your Cloving connection, run:\n\n  cloving integrations approve zapier\n\nYou will be asked to paste the pairing code shown beside the connection in Zapier.\n",
      );
    }
    return;
  }
  if (command === "approve") {
    let selectedId = connectionId;
    let code = values["pairing-code"];
    const interactive = Boolean(process.stdin.isTTY) && !values.json;
    if (!selectedId && interactive) {
      const approved = new Set((await connections.records()).map(([id]) => id));
      const pending: Record<string, unknown>[] = [];
      for (const [, value] of await preparations.records()) {
        for (const row of await preparedConnections(
          value as unknown as PreparationConfig,
        )) {
          if (!approved.has(String(row.connection_id))) pending.push(row);
        }
      }
      if (!pending.length) throw new Error("connection-unknown");
      let index = 0;
      if (pending.length > 1) {
        process.stdout.write("Choose the Zapier connection to approve:\n");
        pending.forEach((row, position) =>
          process.stdout.write(`  ${position + 1}. ${row.connection_id}\n`),
        );
        index = Number(await answer("Connection number: ")) - 1;
        if (!Number.isInteger(index) || !pending[index])
          throw new Error("connection-unknown");
      }
      selectedId = String(pending[index]!.connection_id);
    }
    if (!selectedId) throw new Error("connection-id-required");
    if (!code && interactive) {
      process.stdout.write(
        "In Zapier, find the pairing code beside your Cloving connection name.\nCompare it by pasting it below. This approves only the workflows you selected.\n\n",
      );
      code = await answer("Pairing code from Zapier: ");
    }
    if (!code) throw new Error("pairing-code-required");
    for (const [, value] of await preparations.records()) {
      const preparation = value as unknown as PreparationConfig;
      const pending = (await preparedConnections(preparation)).find(
        (row) => row.connection_id === selectedId,
      );
      if (!pending) continue;
      const config = approvePreparation(
        preparation,
        pending,
        code.trim().toUpperCase(),
      );
      await connections.write(selectedId, config);
      await publishCatalog(config, {
        service: (request) => serviceRequest(config.runtimeDirectory, request),
        transport: (token) => httpTransport(config.origin, token),
        fields: () => declarationFields(config.runtimeDirectory),
      });
      if (values.json)
        process.stdout.write(
          JSON.stringify({
            connection_id: selectedId,
            approved: true,
            workflows: config.workflows,
            next: "Run cloving integrations serve zapier to process encrypted workflow requests.",
          }) + "\n",
        );
      else
        process.stdout.write(
          `\nZapier is approved for ${config.workflows.join(", ")}.\n\nStart the connection with:\n  cloving integrations serve zapier\n\nKeep that terminal running so Zapier can start workflows and receive updates.\n`,
        );
      return;
    }
    throw new Error("connection-unknown");
  }
  if (command === "remove") {
    if (!connectionId) throw new Error("connection-id-required");
    const config = await connections.read(connectionId);
    if (!config) throw new Error("connection-unknown");
    await connections.write(connectionId, {
      ...config,
      revokedAt: new Date().toISOString(),
    });
    await httpTransport(String(config.origin), String(config.daemonToken))(
      "DELETE",
      `/api/v1/relay/automation_connections/${connectionId}`,
    );
    if (values.json)
      process.stdout.write(
        JSON.stringify({ connection_id: connectionId, revoked: true }) + "\n",
      );
    else
      process.stdout.write(
        "The Zapier connection has been removed. It can no longer start workflows or read new state.\n",
      );
    return;
  }
  const stop = new AbortController();
  const interrupt = () => stop.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const bridges = new Map<string, ReturnType<typeof createBridge>>();
  if (!values.json && !values.once)
    process.stdout.write(
      "Listening for encrypted Zapier requests.\nKeep this terminal open. Press Ctrl+C to stop the connection.\n",
    );
  try {
    do {
      const configs = (await connections.records()).filter(
        ([id, config]) =>
          !config.revokedAt && (!connectionId || id === connectionId),
      );
      if (configs.length === 0) throw new Error("connection-unknown");
      for (const [id, value] of configs) {
        if (stop.signal.aborted) break;
        const config = value as unknown as ConnectionConfig;
        let bridge = bridges.get(id);
        if (!bridge) {
          const store = new Store(join(directory, "records", id));
          bridge = createBridge(config, {
            service: (request) =>
              serviceRequest(config.runtimeDirectory, request),
            transport: httpTransport(config.origin, config.daemonToken),
            store,
            fields: () => declarationFields(config.runtimeDirectory),
            revoked: async () => {
              const current = await connections.read(id);
              return current === undefined || Boolean(current.revokedAt);
            },
          });
          bridges.set(id, bridge);
        }
        try {
          await bridge.tick();
        } catch (error) {
          const code = String(object(error).message ?? "adapter-unavailable");
          if (values.once) throw new Error(code);
          process.stderr.write(
            /^(relay-status-\d+|service-unavailable|connection-revoked)$/.test(
              code,
            )
              ? `${code}\n`
              : "adapter-retry\n",
          );
        }
      }
      if (!values.once && !stop.signal.aborted)
        await delay(2000, undefined, { signal: stop.signal }).catch(
          () => undefined,
        );
    } while (!values.once && !stop.signal.aborted);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

try {
  await main();
} catch (error) {
  const code = String(object(error).message ?? "command-failed");
  const hints: Record<string, string> = {
    "runtime-directory-required":
      "Cloving could not find a running project here.\n\nGo to your Cloving project folder, start it with cloving start, then run:\n  cloving integrations connect zapier\n\nYou can also choose a project with --repository /path/to/project.\n",
    "service-unavailable":
      "The Cloving service is not running for this project.\nRun cloving start in your project folder, then try this command again.\n",
    "pairing-code-required":
      "Paste the pairing code shown beside your Cloving connection in Zapier.\nFor guided approval, run cloving integrations approve zapier in a terminal.\n",
    "connection-id-required":
      "Run cloving integrations approve zapier in a terminal to choose the connection and paste its pairing code.\n",
    "connection-unknown":
      "There is no matching Zapier connection in this project.\nFinish signing in with Cloving in Zapier and click Authorize Zapier, then run cloving integrations approve zapier from the same project folder.\n",
    "pairing-code-mismatch":
      "That pairing code does not match this connection. Nothing was approved.\nCopy the code beside your Cloving connection in Zapier and try again.\n",
    "workflow-selection-requires-terminal":
      "Run this command in a terminal to choose workflows, or pass --workflow NAME.\n",
    "workflow-selection-cancelled": "Connection cancelled.\n",
    "workflow-unavailable":
      "No selected workflows are available in the running Cloving service.\n",
  };
  process.stderr.write(
    (process.argv.includes("--json") ? undefined : hints[code]) ??
      (/^[a-z][a-z0-9-]{0,80}$/.test(code) ? `${code}\n` : "command-failed\n"),
  );
  process.exitCode = 1;
}
