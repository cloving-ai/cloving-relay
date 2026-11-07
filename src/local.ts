import { createHash, randomUUID } from "node:crypto";
import { canonical, openMessage, sealMessage, type Keys } from "./protocol.js";

export interface LocalGrant {
  readonly version: 1;
  readonly connectionId: string;
  readonly keys: Keys;
  readonly clientAgreementPublicKey: string;
  readonly clientSigningPublicKey: string;
  readonly workflows: readonly string[];
}

export interface RelayMessage {
  readonly message_id: string;
  readonly channel: string;
  readonly slot?: string | null;
  readonly ciphertext: string;
  readonly expires_at?: string;
  readonly sequence?: number;
}

export interface LocalPorts {
  readonly send: (request: {
    readonly operation: string;
    readonly parameters: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  readonly publish: (message: RelayMessage) => Promise<void>;
  readonly remember: (
    key: string,
    value: Record<string, unknown>,
  ) => Promise<void>;
  readonly known: (key: string) => Promise<Record<string, unknown> | undefined>;
  readonly records?: () => Promise<
    readonly (readonly [string, Record<string, unknown>])[]
  >;
  readonly now: () => number;
}

export class InvalidMessage extends Error {}

export class LocalConnection {
  constructor(
    private readonly grant: LocalGrant,
    private readonly ports: LocalPorts,
  ) {}

  async receive(message: RelayMessage): Promise<void> {
    let value: Record<string, unknown>;
    try {
      value = await openMessage(
        this.grant.keys,
        this.grant.clientSigningPublicKey,
        { connectionId: this.grant.connectionId, direction: "request" },
        message.ciphertext,
      );
    } catch {
      throw new InvalidMessage("message-invalid");
    }
    if (
      value.version !== 1 ||
      value.connectionId !== this.grant.connectionId ||
      value.direction !== "request" ||
      value.channel !== "request" ||
      message.channel !== "request" ||
      value.messageId !== message.message_id
    )
      throw new InvalidMessage("message-binding-invalid");
    const body = object(value.body);
    const requestId = body.requestId;
    if (
      typeof requestId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(requestId)
    )
      throw new InvalidMessage("request-invalid");
    const refuse = (error: string) =>
      this.publish("reply", requestId, {
        request_id: requestId,
        delivery_status: "refused",
        error,
      });
    const now = this.ports.now();
    if (
      typeof value.expiresAt !== "number" ||
      typeof value.issuedAt !== "number" ||
      value.expiresAt <= now ||
      value.issuedAt > now + 30000 ||
      value.expiresAt - value.issuedAt > 300000 ||
      value.expiresAt <= value.issuedAt
    )
      return refuse("request-expired");
    if (body.operation !== "run") return refuse("operation-not-allowed");
    if (
      typeof body.workflowId !== "string" ||
      !this.grant.workflows.includes(body.workflowId)
    )
      return refuse("workflow-not-allowed");
    if (
      typeof body.input !== "object" ||
      body.input === null ||
      Array.isArray(body.input)
    )
      return refuse("input-invalid");
    const digest = createHash("sha256")
      .update(canonical({ workflowId: body.workflowId, input: body.input }))
      .digest("hex");
    const known = await this.ports.known(requestId);
    if (known !== undefined) {
      if (known.digest !== digest) return refuse("conflicting-command");
      return this.publish("reply", requestId, object(known.reply));
    }
    const commandId = `zapier-${createHash("sha256").update(`${this.grant.connectionId}|${requestId}`).digest("hex")}`;
    const reply = await this.ports.send({
      operation: "run",
      parameters: {
        workflowId: body.workflowId,
        source: "input",
        submission: body.input,
        commandId,
      },
    });
    if (
      reply.ok !== true &&
      ["outcome-unknown", "service-unavailable", "resolver-timeout"].includes(
        String(object(reply.error).code),
      )
    )
      throw new Error("service-unavailable");
    const result = object(reply.result);
    if (reply.ok !== true || typeof result.runId !== "string")
      return refuse(
        String(object(reply.error).code ?? "submission-unavailable"),
      );
    const response = {
      request_id: requestId,
      run_id: result.runId,
      workflow_id: body.workflowId,
      delivery_status: "admitted",
    };
    await this.ports.remember(requestId, {
      digest,
      reply: response,
      runId: result.runId,
      workflowId: body.workflowId,
    });
    await this.publish("reply", requestId, response);
  }

  async publish(
    channel: string,
    slot: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const now = this.ports.now();
    const messageId = randomUUID();
    const expiresAt = now + 7 * 86400000;
    const ciphertext = await sealMessage(
      this.grant.keys,
      this.grant.clientAgreementPublicKey,
      { connectionId: this.grant.connectionId, direction: "response" },
      {
        version: 1,
        connectionId: this.grant.connectionId,
        direction: "response",
        messageId,
        channel,
        slot,
        issuedAt: now,
        expiresAt,
        body,
      },
    );
    await this.ports.publish({
      message_id: messageId,
      channel,
      slot,
      ciphertext,
      expires_at: new Date(expiresAt).toISOString(),
    });
  }

  async refresh(): Promise<void> {
    for (const [requestId, record] of (await this.ports.records?.()) ?? []) {
      if (record.terminal === true) continue;
      if (
        typeof record.runId !== "string" ||
        typeof record.workflowId !== "string" ||
        !this.grant.workflows.includes(record.workflowId)
      )
        continue;
      const response = await this.ports.send({
        operation: "status",
        parameters: { runId: record.runId },
      });
      const run = object(object(response.result).run);
      if (
        response.ok !== true ||
        run.runId !== record.runId ||
        run.workflowId !== record.workflowId
      )
        continue;
      const projection = {
        run_id: record.runId,
        request_id: requestId,
        workflow_id: record.workflowId,
        state: run.state,
        revision: run.revision ?? null,
        sequence: run.latestSequence ?? null,
        current_step:
          typeof run.currentStep === "string" ? run.currentStep : null,
      };
      const fingerprint = createHash("sha256")
        .update(canonical(projection))
        .digest("hex");
      if (
        record.stateFingerprint === fingerprint &&
        Number(record.publishedAt) > this.ports.now() - 60000
      )
        continue;
      const state = {
        ...projection,
        id: fingerprint,
        observed_at: new Date(this.ports.now()).toISOString(),
      };
      const slot = createHash("sha256")
        .update(`${this.grant.connectionId}|${record.runId}`)
        .digest("hex");
      if (record.stateFingerprint !== fingerprint)
        await this.publish("event", slot, state);
      await this.publish("state", slot, state);
      await this.ports.remember(requestId, {
        ...record,
        stateFingerprint: fingerprint,
        publishedAt: this.ports.now(),
        terminal: ["completed", "failed", "cancelled"].includes(
          String(run.state),
        ),
      });
    }
  }
}

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
