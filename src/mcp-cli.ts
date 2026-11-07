#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { runIntegrationCli } from "./integration-cli.js";
import { Store } from "./runtime.js";
import { object } from "./local.js";
import { relayOrigin } from "./http.js";
import { pairingCode } from "./oauth.js";
import { pairMcp, type McpCredential } from "./mcp-auth.js";
import { McpClient } from "./mcp-relay.js";
import { serveMcp } from "./mcp-server.js";
import { credentialTransport, unpairMcpCredential } from "./mcp-credentials.js";

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  if (
    ["connect", "approve", "serve", "list", "remove"].includes(
      argumentsList[0] ?? "",
    )
  )
    return runIntegrationCli("mcp");
  const { values, positionals } = parseArgs({
    options: {
      connection: { type: "string" },
      name: { type: "string" },
      "state-dir": { type: "string" },
      origin: { type: "string" },
      "no-open": { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help || (!values.connection && positionals.length === 0)) {
    process.stdout.write(
      "Encrypted Cloving MCP bridge\n\nOn the computer running your workflows:\n  cloving integrations connect mcp\n  cloving integrations approve mcp\n  cloving integrations serve mcp\n\nOn the machine running your MCP harness:\n  cloving integrations pair mcp --name studio\n  cloving mcp --connection studio\n  cloving integrations unpair mcp --name studio\n\nYou can also configure the harness to launch: cloving-mcp --connection studio\nAll workflows start selected. Access defaults to read/start. Add --allow-control, --allow-answer, or --allow-approvals during computer setup to grant additional tools.\nUse --state-dir for private storage and --origin for a self-hosted relay. URL-only remote MCP clients require a client-side bridge to preserve encryption.\n",
    );
    return;
  }
  const directory =
    values["state-dir"] ??
    process.env.CLOVING_MCP_STATE_DIR ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "cloving",
      "mcp",
    );
  const store = new Store(join(directory, "clients"));
  const name = values.connection ?? values.name ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
    throw new Error("connection-name-invalid");
  if (
    positionals[0] === "pair" &&
    positionals[1] === "mcp" &&
    positionals.length === 2
  ) {
    if (await store.read(name)) throw new Error("connection-name-exists");
    const origin = relayOrigin(values.origin ?? "https://cloving.ai");
    process.stdout.write(
      "Connect this harness to your Cloving computer\n\nSign in with Cloving, select your linked MCP computer, and click Authorize MCP.\nIf no computer is listed, run cloving integrations connect mcp on that computer first.\n\n",
    );
    const stop = new AbortController();
    const cancel = () => stop.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let credential: McpCredential;
    try {
      credential = await pairMcp(origin, {
        signal: stop.signal,
        authorize: async (url) => {
          process.stdout.write(
            `Open this sign-in page on this machine:\n\n  ${url}\n\nWaiting for sign-in…\n`,
          );
          if (!values["no-open"] && process.stdin.isTTY) {
            await new Promise<void>((resolve) =>
              execFile(
                process.platform === "darwin" ? "open" : "xdg-open",
                [url],
                { timeout: 5000 },
                () => resolve(),
              ),
            );
          }
        },
      });
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
    await store.write(name, credential);
    const code = pairingCode({
      origin,
      connectionId: credential.connectionId,
      daemonAgreementPublicKey: credential.daemonAgreementPublicKey,
      daemonSigningPublicKey: credential.daemonSigningPublicKey,
      clientAgreementPublicKey: credential.keys.agreementPublicKey,
      clientSigningPublicKey: credential.keys.signingPublicKey,
    });
    process.stdout.write(
      `Signed in. Your computer still needs to approve this harness.\n\nPairing code: ${code}\n\nOn your Cloving computer, run:\n  cloving integrations approve mcp\n\nPaste the pairing code above there, then keep cloving integrations serve mcp running.\n\nAdd this MCP server to your harness configuration:\n${JSON.stringify({ mcpServers: { cloving: { command: "cloving-mcp", args: ["--connection", name, ...(values["state-dir"] ? ["--state-dir", directory] : [])] } } }, null, 2)}\n\nThe harness keeps its private keys here. The relay receives encrypted messages only.\n`,
    );
    return;
  }
  if (
    positionals[0] === "unpair" &&
    positionals[1] === "mcp" &&
    positionals.length === 2
  ) {
    await unpairMcpCredential(store, name);
    process.stdout.write(
      "The harness connection was revoked and its saved credential was removed. You can now pair this name again.\n",
    );
    return;
  }
  if (!values.connection || positionals.length > 0)
    throw new Error("usage-error");
  const { credential, transport } = await credentialTransport(store, name);
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    await serveMcp(new McpClient(credential, transport), {
      input: process.stdin,
      output: process.stdout,
      signal: stop.signal,
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

try {
  await main();
} catch (error) {
  const code = String(object(error).message ?? "command-failed");
  const hints: Record<string, string> = {
    "connection-unknown":
      "No saved MCP connection was found. Run cloving integrations pair mcp --name NAME on the harness machine first.\n",
    "connection-name-exists":
      "That MCP connection name already exists. Choose another --name to pair a separate harness.\n",
    "connection-name-invalid":
      "Use a connection name containing letters, numbers, underscores, or hyphens.\n",
    "oauth-refresh-outcome-unknown":
      "A token refresh was interrupted. To recover safely, run cloving integrations unpair mcp --name NAME, then cloving integrations pair mcp --name NAME.\n",
    "oauth-cancelled":
      "MCP connection cancelled. Nothing was approved on your computer.\n",
    "oauth-pairing-timeout":
      "Sign-in timed out. Run cloving integrations pair mcp again.\n",
  };
  process.stderr.write(
    hints[code] ??
      (/^[a-z][a-z0-9-]{0,80}$/.test(code) ? `${code}\n` : "command-failed\n"),
  );
  process.exitCode = 1;
}
