import { newIdentity } from "./identity.js";
import { pairingCode } from "./oauth.js";
import { object, LocalConnection } from "./local.js";
import type { ConnectionConfig, EnrollmentPorts } from "./enrollment.js";

export interface PreparationConfig {
  readonly integration?: "zapier" | "mcp";
  readonly permissions?: readonly string[];
  readonly version: 2;
  readonly setupId: string;
  readonly origin: string;
  readonly runtimeDirectory: string;
  readonly daemonId: string;
  readonly daemonToken: string;
  readonly keys: ConnectionConfig["keys"];
  readonly workflows: readonly string[];
}

export async function prepare(
  options: {
    origin: string;
    runtimeDirectory: string;
    workflows: readonly string[];
    name?: string;
    integration?: "zapier" | "mcp";
    permissions?: readonly string[];
  },
  ports: EnrollmentPorts,
): Promise<{ config: PreparationConfig; setupUrl: string }> {
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
  const daemon = object(
    await ports.transport()("POST", "/api/v1/relay/daemons", {
      name: options.name ?? "Cloving computer",
      agreement_public_key: keys.agreementPublicKey,
      signing_public_key: keys.signingPublicKey,
    }),
  );
  if (typeof daemon.daemon_id !== "string" || typeof daemon.token !== "string")
    throw new Error("registration-invalid");
  const setup = object(
    await ports.transport(daemon.token)(
      "POST",
      "/api/v1/relay/automation_setups",
      ...(options.integration === "mcp" ? [{ integration: "mcp" }] : []),
    ),
  );
  if (
    typeof setup.setup_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(setup.setup_id) ||
    typeof setup.claim_code !== "string" ||
    !setup.claim_code
  )
    throw new Error("registration-invalid");
  return {
    config: {
      version: 2,
      ...(options.integration === "mcp"
        ? {
            integration: "mcp",
            permissions: options.permissions ?? ["read", "start"],
          }
        : {}),
      setupId: setup.setup_id,
      origin: options.origin,
      runtimeDirectory: options.runtimeDirectory,
      daemonId: daemon.daemon_id,
      daemonToken: daemon.token,
      keys,
      workflows: [...new Set(options.workflows)],
    },
    setupUrl: `${options.origin}/connections/${options.integration ?? "zapier"}/${setup.setup_id}?${new URLSearchParams({ claim_code: setup.claim_code })}`,
  };
}

export function pendingCode(config: PreparationConfig, value: unknown): string {
  const row = object(value);
  if (
    (row.integration ?? "zapier") !== (config.integration ?? "zapier") ||
    typeof row.connection_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(row.connection_id) ||
    typeof row.agreement_public_key !== "string" ||
    typeof row.signing_public_key !== "string"
  )
    throw new Error("connection-invalid");
  return pairingCode({
    origin: config.origin,
    connectionId: row.connection_id,
    daemonAgreementPublicKey: config.keys.agreementPublicKey,
    daemonSigningPublicKey: config.keys.signingPublicKey,
    clientAgreementPublicKey: row.agreement_public_key,
    clientSigningPublicKey: row.signing_public_key,
  });
}

export function approvePreparation(
  config: PreparationConfig,
  value: unknown,
  code: string,
): ConnectionConfig {
  if (pendingCode(config, value) !== code)
    throw new Error("pairing-code-mismatch");
  const row = object(value);
  return {
    version: 1,
    ...(config.integration === "mcp"
      ? {
          integration: "mcp",
          permissions: config.permissions ?? ["read", "start"],
        }
      : {}),
    origin: config.origin,
    runtimeDirectory: config.runtimeDirectory,
    daemonId: config.daemonId,
    daemonToken: config.daemonToken,
    keys: config.keys,
    workflows: config.workflows,
    connectionId: String(row.connection_id),
    clientAgreementPublicKey: String(row.agreement_public_key),
    clientSigningPublicKey: String(row.signing_public_key),
  };
}

export async function publishCatalog(
  config: ConnectionConfig,
  ports: EnrollmentPorts,
): Promise<void> {
  const fields = await ports.fields();
  const local = new LocalConnection(config, {
    send: ports.service,
    now: () => Date.now(),
    known: async () => undefined,
    remember: async () => {},
    publish: async (message) => {
      await ports.transport(config.daemonToken)(
        "POST",
        `/api/v1/relay/automation_connections/${config.connectionId}/messages`,
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
}
