import { createHash, createHmac, randomUUID } from "node:crypto";
import { openMessage, sealMessage, type Keys } from "./protocol.js";
import { object, type RelayMessage } from "./local.js";

export interface Credential {
  readonly version: 1;
  readonly origin: string;
  readonly connectionId: string;
  readonly token: string;
  readonly keys: Keys;
  readonly daemonAgreementPublicKey: string;
  readonly daemonSigningPublicKey: string;
}

export type Transport = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<unknown>;

export function stateSlot(connectionId: string, runId: string): string {
  return createHash("sha256").update(`${connectionId}|${runId}`).digest("hex");
}

export class Client {
  readonly path: string;

  constructor(
    private readonly credential: Credential,
    private readonly transport: Transport,
  ) {
    this.path = `/api/v1/relay/automation_connections/${credential.connectionId}`;
  }

  async start(input: {
    workflowId: string;
    requestKey: string;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    if (!input.requestKey || input.requestKey.length > 1024)
      throw new Error("request-key-required");
    const requestId = createHmac(
      "sha256",
      Buffer.from(this.credential.keys.signingPrivateKey, "base64url"),
    )
      .update(input.requestKey)
      .digest("hex");
    const now = Date.now();
    const messageId = randomUUID();
    const expiresAt = now + 60000;
    const ciphertext = await sealMessage(
      this.credential.keys,
      this.credential.daemonAgreementPublicKey,
      { connectionId: this.credential.connectionId, direction: "request" },
      {
        version: 1,
        connectionId: this.credential.connectionId,
        direction: "request",
        messageId,
        channel: "request",
        issuedAt: now,
        expiresAt,
        body: {
          operation: "run",
          requestId,
          workflowId: input.workflowId,
          input: input.input,
        },
      },
    );
    await this.transport("POST", `${this.path}/messages`, {
      message_id: messageId,
      channel: "request",
      ciphertext,
      expires_at: new Date(expiresAt).toISOString(),
    });
    return {
      request_id: requestId,
      run_id: null,
      delivery_status: "queued",
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async read(
    channel: string,
    slot?: string,
  ): Promise<Record<string, unknown>[]> {
    return (await this.page(channel, slot)).values;
  }

  private async page(
    channel: string,
    slot?: string,
    before?: number,
  ): Promise<{
    values: Record<string, unknown>[];
    nextBefore: number | undefined;
  }> {
    const query = new URLSearchParams({ channel });
    if (slot !== undefined) query.set("slot", slot);
    if (before !== undefined) query.set("before", String(before));
    const response = object(
      await this.transport("GET", `${this.path}/messages?${query}`),
    );
    if (!Array.isArray(response.messages))
      throw new Error("relay-response-invalid");
    const values = [];
    for (const item of response.messages) {
      const row = item as RelayMessage;
      const value = await openMessage(
        this.credential.keys,
        this.credential.daemonSigningPublicKey,
        { connectionId: this.credential.connectionId, direction: "response" },
        row.ciphertext,
      );
      if (
        value.version !== 1 ||
        value.connectionId !== this.credential.connectionId ||
        value.direction !== "response" ||
        value.messageId !== row.message_id ||
        value.channel !== channel ||
        row.channel !== channel ||
        value.slot !== row.slot ||
        (slot !== undefined && value.slot !== slot)
      )
        throw new Error("message-binding-invalid");
      if (
        typeof value.expiresAt !== "number" ||
        typeof value.issuedAt !== "number" ||
        value.expiresAt <= Date.now() ||
        value.issuedAt > Date.now() + 30000
      )
        throw new Error("response-expired");
      values.push(object(value.body));
    }
    const next = response.next_before;
    if (
      next !== undefined &&
      next !== null &&
      (typeof next !== "number" ||
        !Number.isSafeInteger(next) ||
        next < 1 ||
        (before !== undefined && next >= before))
    )
      throw new Error("relay-pagination-invalid");
    return { values, nextBefore: typeof next === "number" ? next : undefined };
  }

  async events(): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + 20000;
    const values: Record<string, unknown>[] = [];
    let before: number | undefined;
    do {
      const page = await this.page("event", undefined, before);
      values.push(...page.values);
      before = page.nextBefore;
      if (before !== undefined && Date.now() >= deadline)
        throw new Error("event-catchup-timeout");
    } while (before !== undefined);
    return values;
  }

  async run(selection: {
    requestId?: string;
    runId?: string;
  }): Promise<Record<string, unknown>> {
    let runId = selection.runId;
    let admission: Record<string, unknown> = {};
    if (selection.requestId !== undefined) {
      admission = (await this.read("reply", selection.requestId))[0] ?? {
        request_id: selection.requestId,
        delivery_status: "pending",
      };
      if (typeof admission.run_id !== "string") return admission;
      runId = admission.run_id;
    }
    if (!runId) throw new Error("run-reference-required");
    const state = (
      await this.read("state", stateSlot(this.credential.connectionId, runId))
    )[0];
    return {
      ...admission,
      ...(state ?? { run_id: runId, state: "unavailable" }),
    };
  }
}
