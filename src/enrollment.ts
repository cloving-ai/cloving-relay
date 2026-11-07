import { randomUUID } from "node:crypto";
import { newIdentity } from "./identity.js";
import {
  object,
  LocalConnection,
  type LocalGrant,
  type LocalPorts,
} from "./local.js";
import type { Credential, Transport } from "./client.js";

export interface ConnectionConfig extends LocalGrant {
  readonly integration?: "zapier" | "mcp";
  readonly permissions?: readonly string[];
  readonly origin: string;
  readonly runtimeDirectory: string;
  readonly daemonId: string;
  readonly daemonToken: string;
}

export interface EnrollmentPorts {
  readonly transport: (token?: string) => Transport;
  readonly service: LocalPorts["send"];
  readonly fields: () => Promise<Record<string, unknown>>;
}

export async function enroll(
  options: {
    origin: string;
    runtimeDirectory: string;
    workflows: readonly string[];
  },
  ports: EnrollmentPorts,
): Promise<{ config: ConnectionConfig; credential: Credential }> {
  const status = await ports.service({
    operation: "status",
    parameters: { limit: 1 },
  });
  const workflows = object(status.result).workflows;
  if (status.ok !== true || !Array.isArray(workflows))
    throw new Error("service-unavailable");
  if (
    options.workflows.length === 0 ||
    options.workflows.some((id) => !workflows.includes(id))
  )
    throw new Error("workflow-unavailable");
  const keys = newIdentity();
  const client = newIdentity();
  const daemon = object(
    await ports.transport()("POST", "/api/v1/relay/daemons", {
      agreement_public_key: keys.agreementPublicKey,
      signing_public_key: keys.signingPublicKey,
    }),
  );
  if (typeof daemon.daemon_id !== "string" || typeof daemon.token !== "string")
    throw new Error("registration-invalid");
  const connectionId = randomUUID();
  const connection = object(
    await ports.transport(daemon.token)(
      "POST",
      "/api/v1/relay/automation_connections",
      {
        connection_id: connectionId,
        agreement_public_key: client.agreementPublicKey,
        signing_public_key: client.signingPublicKey,
      },
    ),
  );
  if (typeof connection.token !== "string")
    throw new Error("registration-invalid");
  const config: ConnectionConfig = {
    version: 1,
    connectionId,
    origin: options.origin,
    runtimeDirectory: options.runtimeDirectory,
    daemonId: daemon.daemon_id,
    daemonToken: daemon.token,
    keys,
    clientAgreementPublicKey: client.agreementPublicKey,
    clientSigningPublicKey: client.signingPublicKey,
    workflows: [...new Set(options.workflows)],
  };
  const credential: Credential = {
    version: 1,
    origin: options.origin,
    connectionId,
    token: connection.token,
    keys: client,
    daemonAgreementPublicKey: keys.agreementPublicKey,
    daemonSigningPublicKey: keys.signingPublicKey,
  };
  const fields = await ports.fields();
  const local = new LocalConnection(config, {
    send: ports.service,
    now: () => Date.now(),
    known: async () => undefined,
    remember: async () => {},
    publish: async (message) => {
      await ports.transport(config.daemonToken)(
        "POST",
        `/api/v1/relay/automation_connections/${connectionId}/messages`,
        message,
      );
    },
  });
  await local.publish("catalog", "catalog", {
    workflows: config.workflows.map((id) => ({
      id,
      name: id,
      inputFields: fields[id] ?? [],
    })),
    observed_at: new Date().toISOString(),
  });
  return { config, credential };
}
