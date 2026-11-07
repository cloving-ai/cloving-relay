import {
  LocalConnection,
  InvalidMessage,
  object,
  type LocalPorts,
} from "./local.js";
import type { ConnectionConfig } from "./enrollment.js";
import type { Transport } from "./client.js";

export interface BridgePorts {
  readonly transport: Transport;
  readonly service: LocalPorts["send"];
  readonly store: {
    read: LocalPorts["known"];
    write: LocalPorts["remember"];
    records: NonNullable<LocalPorts["records"]>;
  };
  readonly fields: () => Promise<Record<string, unknown>>;
  readonly revoked: () => Promise<boolean>;
}

export function createBridge(
  config: ConnectionConfig,
  ports: BridgePorts,
): { tick: () => Promise<void> } {
  const path = `/api/v1/relay/automation_connections/${config.connectionId}`;
  const local = new LocalConnection(config, {
    send: ports.service,
    now: () => Date.now(),
    known: (key) => ports.store.read(key),
    remember: (key, value) => ports.store.write(key, value),
    records: () => ports.store.records(),
    publish: async (message) => {
      await ports.transport("POST", `${path}/messages`, message);
    },
  });
  let catalogAt = 0;
  return {
    tick: async () => {
      if (await ports.revoked()) throw new Error("connection-revoked");
      const page = object(
        await ports.transport("GET", `${path}/messages?channel=request`),
      );
      if (!Array.isArray(page.messages))
        throw new Error("relay-response-invalid");
      for (const message of page.messages) {
        if (await ports.revoked()) throw new Error("connection-revoked");
        try {
          await local.receive(message);
        } catch (error) {
          if (!(error instanceof InvalidMessage)) throw error;
        }
        await ports.transport(
          "DELETE",
          `${path}/messages/${message.message_id}`,
        );
      }
      await local.refresh();
      if (catalogAt < Date.now() - 60000) {
        const status = await ports.service({
          operation: "status",
          parameters: { limit: 1 },
        });
        const workflows = object(status.result).workflows;
        if (status.ok !== true || !Array.isArray(workflows))
          throw new Error("service-unavailable");
        const fields = await ports.fields();
        await local.publish("catalog", "catalog", {
          workflows: config.workflows
            .filter((id) => workflows.includes(id))
            .map((id) => ({ id, name: id, inputFields: fields[id] ?? [] })),
          observed_at: new Date().toISOString(),
        });
        catalogAt = Date.now();
      }
    },
  };
}
