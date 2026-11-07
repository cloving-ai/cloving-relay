import { createHash, createHmac, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, type Credential, type Transport } from "./client.js";
import { canonical, openMessage, sealMessage } from "./protocol.js";
import {
  LocalConnection,
  object,
  type LocalPorts,
  type RelayMessage,
} from "./local.js";
import type { ConnectionConfig } from "./enrollment.js";
import {
  callMcpTool,
  mcpTools,
  mcpServiceResult,
  type McpGrant,
} from "./mcp-tools.js";

export interface McpConnection extends ConnectionConfig {
  readonly integration: "mcp";
  readonly permissions: McpGrant["permissions"];
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function bounded(result: Record<string, unknown>): Record<string, unknown> {
  return Buffer.byteLength(canonical(result)) <= 16384
    ? result
    : {
        isError: true,
        structuredContent: { error: "result-too-large" },
        content: [
          {
            type: "text",
            text: "result-too-large: Request fewer events or runs with limit. This result exceeds the encrypted message size limit.",
          },
        ],
      };
}

export class McpClient {
  constructor(
    private readonly credential: Credential,
    private readonly transport: Transport,
    private readonly options: {
      wait?: (signal?: AbortSignal) => Promise<unknown>;
      timeoutMs?: number;
    } = {},
  ) {}

  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const args = object(params.arguments);
    const requestId =
      typeof args.commandId === "string"
        ? createHmac(
            "sha256",
            Buffer.from(this.credential.keys.signingPrivateKey, "base64url"),
          )
            .update(args.commandId)
            .digest("hex")
        : randomUUID();
    const request = {
      method,
      params:
        method === "tools/call"
          ? { name: params.name, arguments: object(params.arguments) }
          : {},
    };
    const requestDigest = digest(request);
    const now = Date.now();
    const expiresAt = now + Math.min(this.options.timeoutMs ?? 30000, 60000);
    const messageId = randomUUID();
    const path = `/api/v1/relay/automation_connections/${this.credential.connectionId}/messages`;
    signal?.throwIfAborted();
    const ciphertext = await sealMessage(
      this.credential.keys,
      this.credential.daemonAgreementPublicKey,
      { connectionId: this.credential.connectionId, direction: "request" },
      {
        version: 1,
        connectionId: this.credential.connectionId,
        direction: "request",
        channel: "request",
        messageId,
        issuedAt: now,
        expiresAt,
        body: { protocol: "mcp-v1", requestId, ...request },
      },
    );
    await this.transport("POST", path, {
      message_id: messageId,
      channel: "request",
      ciphertext,
      expires_at: new Date(expiresAt).toISOString(),
    });
    const client = new Client(this.credential, this.transport);
    while (Date.now() < expiresAt) {
      signal?.throwIfAborted();
      for (const response of await client.read("reply", requestId)) {
        if (
          response.protocol === "mcp-v1" &&
          response.requestId === requestId &&
          response.requestDigest === requestDigest
        )
          return object(response.result);
      }
      if (this.options.wait) await this.options.wait(signal);
      else await delay(250, undefined, signal ? { signal } : {});
    }
    throw new Error("computer-offline-or-outcome-unknown");
  }
}

export function createMcpBridge(
  config: McpConnection,
  ports: {
    readonly transport: Transport;
    readonly service: LocalPorts["send"];
    readonly fields: () => Promise<Record<string, unknown>>;
    readonly store: {
      read: LocalPorts["known"];
      write: LocalPorts["remember"];
    };
    readonly revoked: () => Promise<boolean>;
  },
) {
  if (config.integration !== "mcp") throw new Error("connection-invalid");
  const path = `/api/v1/relay/automation_connections/${config.connectionId}/messages`;
  const publisher = new LocalConnection(config, {
    send: ports.service,
    now: Date.now,
    known: ports.store.read,
    remember: ports.store.write,
    publish: async (message) => {
      await ports.transport("POST", path, message);
    },
  });
  const receive = async (message: RelayMessage) => {
    let value: Record<string, unknown>;
    try {
      value = await openMessage(
        config.keys,
        config.clientSigningPublicKey,
        { connectionId: config.connectionId, direction: "request" },
        message.ciphertext,
      );
    } catch {
      return;
    }
    if (
      value.version !== 1 ||
      value.connectionId !== config.connectionId ||
      value.direction !== "request" ||
      value.channel !== "request" ||
      message.channel !== "request" ||
      value.messageId !== message.message_id
    )
      return;
    const body = object(value.body);
    if (
      body.protocol !== "mcp-v1" ||
      typeof body.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(body.requestId) ||
      typeof body.method !== "string" ||
      typeof body.params !== "object" ||
      body.params === null ||
      Array.isArray(body.params)
    )
      return;
    const requestDigest = digest({ method: body.method, params: body.params });
    const respond = async (result: Record<string, unknown>) =>
      publisher.publish("reply", String(body.requestId), {
        protocol: "mcp-v1",
        requestId: body.requestId,
        requestDigest,
        result: bounded(result),
      });
    const refuse = (error: string) =>
      respond({
        isError: true,
        structuredContent: { error },
        content: [{ type: "text", text: error }],
      });
    const now = Date.now();
    if (
      typeof value.issuedAt !== "number" ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.issuedAt) ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.issuedAt > now + 30000 ||
      value.expiresAt <= value.issuedAt ||
      value.expiresAt - value.issuedAt > 60000
    )
      return refuse("request-expired");
    const known = await ports.store.read(body.requestId);
    if (known && known.digest !== requestDigest)
      return refuse("conflicting-command");
    if (known?.result) return respond(object(known.result));
    let result: Record<string, unknown>;
    if (known?.pending) {
      const pending = object(known.pending);
      result = mcpServiceResult(
        await ports.service({
          operation: String(pending.operation),
          parameters: object(pending.parameters),
        }),
      );
    } else if (body.method === "tools/list")
      result = { tools: mcpTools(config) };
    else if (body.method === "tools/call") {
      const params = object(body.params);
      const args = { ...object(params.arguments) };
      result = await callMcpTool(config, String(params.name), args, {
        ...ports,
        service: async (request) => {
          if (!["run", "run-command", "decision"].includes(request.operation))
            return ports.service(request);
          const pending = {
            ...request,
            parameters: {
              ...request.parameters,
              commandId: `mcp-${digest([config.connectionId, request.parameters.commandId])}`,
            },
          };
          await ports.store.write(String(body.requestId), {
            digest: requestDigest,
            pending,
          });
          return ports.service(pending);
        },
      });
    } else return refuse("method-not-allowed");
    const error = object(result.structuredContent).error;
    if (
      ["service-unavailable", "outcome-unknown", "resolver-timeout"].includes(
        String(error),
      )
    )
      throw new Error("service-unavailable");
    result = bounded(result);
    await ports.store.write(body.requestId, { digest: requestDigest, result });
    await respond(result);
  };
  return {
    tick: async () => {
      if (await ports.revoked()) throw new Error("connection-revoked");
      const page = object(
        await ports.transport("GET", `${path}?channel=request`),
      );
      if (!Array.isArray(page.messages))
        throw new Error("relay-response-invalid");
      for (const row of page.messages) {
        if (await ports.revoked()) throw new Error("connection-revoked");
        const message = object(row);
        if (
          typeof message.message_id !== "string" ||
          !/^[A-Za-z0-9_-]{1,64}$/.test(message.message_id) ||
          typeof message.ciphertext !== "string"
        )
          continue;
        await receive(message as unknown as RelayMessage);
        await ports.transport("DELETE", `${path}/${message.message_id}`);
      }
    },
  };
}
