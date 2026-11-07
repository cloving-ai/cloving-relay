import { object, type LocalPorts } from "./local.js";

export interface McpGrant {
  readonly workflows: readonly string[];
  readonly permissions: readonly string[];
}

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly permission: string;
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
}

const key = { type: "string", pattern: "^[A-Za-z0-9._:/-]{1,128}$" };
const integer = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const tools: Tool[] = [
  {
    name: "cloving_workflows",
    description:
      "List permitted workflows and their input fields. Use this before starting a workflow.",
    permission: "read",
    properties: {},
    required: [],
  },
  {
    name: "cloving_run",
    description:
      "Start a permitted workflow. Retry a lost reply with the same commandId and arguments.",
    permission: "start",
    properties: { workflowId: key, input: { type: "object" }, commandId: key },
    required: ["workflowId", "input", "commandId"],
  },
  {
    name: "cloving_status",
    description: "Read permitted runs, or one run by runId.",
    permission: "read",
    properties: {
      runId: key,
      limit: { ...integer, minimum: 1, maximum: 100 },
      after: key,
    },
    required: [],
  },
  {
    name: "cloving_questions",
    description: "Read open questions and approvals for one permitted run.",
    permission: "read",
    properties: { runId: key },
    required: ["runId"],
  },
  {
    name: "cloving_events",
    description: "Read events for one permitted run.",
    permission: "read",
    properties: {
      runId: key,
      after: integer,
      limit: { ...integer, minimum: 1, maximum: 100 },
    },
    required: ["runId"],
  },
  ...["pause", "resume", "drop"].map((command): Tool => ({
    name: `cloving_${command}`,
    description: `${command} a permitted run. Read expectedRevision from cloving_status; retry with the same commandId.`,
    permission: "control",
    properties: { runId: key, expectedRevision: integer, commandId: key },
    required: ["runId", "expectedRevision", "commandId"],
  })),
  ...["answer", "approve", "deny"].map((command): Tool => ({
    name: `cloving_${command}`,
    description: `${command} an open decision. Copy its exact revision, generation, and subjectDigest from cloving_questions. Retry with the same commandId.`,
    permission: command === "answer" ? "answer" : "approve",
    properties: {
      runId: key,
      reference: { type: "string", pattern: "^[A-Za-z0-9._:/-]{1,256}$" },
      expectedRevision: integer,
      generation: integer,
      subjectDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      commandId: key,
      ...(command === "approve"
        ? {}
        : { text: { type: "string", pattern: "\\S" } }),
    },
    required: [
      "runId",
      "reference",
      "expectedRevision",
      "generation",
      "subjectDigest",
      "commandId",
      ...(command === "answer" ? ["text"] : []),
    ],
  })),
];

export function mcpTools(grant: McpGrant): Record<string, unknown>[] {
  return tools
    .filter((tool) => grant.permissions.includes(tool.permission))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object",
        properties: tool.properties,
        required: tool.required,
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: tool.permission === "read",
        idempotentHint: true,
        openWorldHint: tool.permission !== "read",
        destructiveHint: tool.permission !== "read",
      },
    }));
}

function result(
  value: Record<string, unknown>,
  isError = false,
): Record<string, unknown> {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function mcpServiceResult(
  response: Record<string, unknown>,
): Record<string, unknown> {
  return response.ok === true
    ? result(object(response.result))
    : result(
        { error: String(object(response.error).code ?? "service-unavailable") },
        true,
      );
}

function valid(value: unknown, rule: unknown): boolean {
  const schema = object(rule);
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      (typeof schema.pattern !== "string" ||
        new RegExp(schema.pattern).test(value)) &&
      value.length <= 8000
    );
  if (schema.type === "integer")
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= Number(schema.minimum) &&
      value <= Number(schema.maximum)
    );
  return (
    schema.type === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export async function callMcpTool(
  grant: McpGrant,
  name: string,
  args: Record<string, unknown>,
  ports: {
    service: LocalPorts["send"];
    fields?: () => Promise<Record<string, unknown>>;
  },
): Promise<Record<string, unknown>> {
  const tool = tools.find(
    (item) => item.name === name && grant.permissions.includes(item.permission),
  );
  const refuse = (error: string) => result({ error }, true);
  if (!tool) return refuse("tool-not-allowed");
  if (
    tool.required.some((key) => !Object.hasOwn(args, key)) ||
    Object.entries(args).some(
      ([key, value]) =>
        !Object.hasOwn(tool.properties, key) ||
        !valid(value, tool.properties[key]),
    )
  )
    return refuse("arguments-invalid");
  if (
    name === "cloving_run" &&
    !grant.workflows.includes(String(args.workflowId))
  )
    return refuse("workflow-not-allowed");
  const send = async (
    operation: string,
    parameters: Record<string, unknown>,
  ) => {
    const response = await ports.service({ operation, parameters });
    return mcpServiceResult(response);
  };
  if (name === "cloving_run")
    return send("run", {
      workflowId: args.workflowId,
      source: "input",
      submission: args.input,
      commandId: args.commandId,
    });
  const reply = await ports.service({
    operation: "status",
    parameters: {
      ...(args.runId ? { runId: args.runId } : { limit: args.limit ?? 100 }),
      ...(!args.runId && args.after ? { after: args.after } : {}),
    },
  });
  const status = object(reply.result);
  if (reply.ok !== true) return refuse("service-unavailable");
  if (
    args.runId &&
    !grant.workflows.includes(String(object(status.run).workflowId))
  )
    return refuse("workflow-not-allowed");
  if (tool.permission === "control")
    return send("run-command", {
      ...args,
      command: name.slice("cloving_".length),
    });
  if (tool.permission === "answer" || tool.permission === "approve") {
    const questions = await ports.service({
      operation: "questions",
      parameters: { runId: args.runId },
    });
    const decisions = object(questions.result).decisions;
    if (
      questions.ok !== true ||
      !Array.isArray(decisions) ||
      !decisions.some((value) => {
        const decision = object(value);
        return (
          decision.runId === args.runId &&
          decision.decisionId === args.reference &&
          decision.revision === args.expectedRevision &&
          decision.generation === args.generation &&
          decision.subjectDigest === args.subjectDigest
        );
      })
    )
      return refuse("decision-not-allowed");
    const { runId, ...bound } = args;
    return send("decision", {
      ...bound,
      command: name.slice("cloving_".length),
    });
  }
  if (name === "cloving_questions" || name === "cloving_events")
    return send(name.slice("cloving_".length), args);
  if (args.runId) return result({ run: status.run });
  if (name === "cloving_workflows") {
    const fields = (await ports.fields?.()) ?? {};
    const available = Array.isArray(status.workflows) ? status.workflows : [];
    return result({
      workflows: grant.workflows
        .filter((id) => available.includes(id))
        .map((id) => ({ id, inputFields: fields[id] ?? [] })),
    });
  }
  const runs: unknown[] = [];
  const limit = Number(args.limit ?? 100);
  let page = status;
  let after = String(args.after ?? "");
  const deadline = Date.now() + 5000;
  for (let count = 0; count < 100; count++) {
    const rows = Array.isArray(page.runs) ? page.runs : [];
    for (const [index, run] of rows.entries()) {
      if (!grant.workflows.includes(String(object(run).workflowId))) continue;
      runs.push(run);
      if (runs.length === limit)
        return result({
          runs,
          next: index < rows.length - 1 || page.next ? object(run).runId : null,
        });
    }
    if (!page.next) return result({ runs, next: null });
    if (
      typeof page.next !== "string" ||
      page.next <= after ||
      Date.now() >= deadline
    )
      return refuse("status-scan-limit-reached");
    after = page.next;
    const response = await ports.service({
      operation: "status",
      parameters: { after, limit: 500 },
    });
    if (response.ok !== true) return refuse("service-unavailable");
    page = object(response.result);
  }
  return refuse("status-scan-limit-reached");
}
