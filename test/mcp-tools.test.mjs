import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpTools, callMcpTool } from "../dist/mcp-tools.js";

const grant = { workflows: ["develop"], permissions: ["read", "start"] };
const service = async ({ operation, parameters }) => {
  if (operation === "status")
    return {
      ok: true,
      result: parameters.runId
        ? {
            run: {
              runId: parameters.runId,
              workflowId:
                parameters.runId === "private" ? "private-workflow" : "develop",
              state: "running",
              revision: 2,
            },
          }
        : {
            workflows: ["develop", "private-workflow"],
            runs: [
              { runId: "mine", workflowId: "develop" },
              { runId: "private", workflowId: "private-workflow" },
            ],
            privateQueue: "do not disclose",
          },
    };
  return { ok: true, result: { operation, ...parameters } };
};

test("MCP discovery exposes start/read tools and only locally granted workflow names", async () => {
  assert.deepEqual(
    mcpTools(grant).map((tool) => tool.name),
    [
      "cloving_workflows",
      "cloving_run",
      "cloving_status",
      "cloving_questions",
      "cloving_events",
    ],
  );
  const workflows = await callMcpTool(
    grant,
    "cloving_workflows",
    {},
    {
      service,
      fields: async () => ({
        develop: [{ key: "prompt", type: "string" }],
        "private-workflow": [{ key: "secret" }],
      }),
    },
  );
  assert.deepEqual(workflows.structuredContent.workflows, [
    { id: "develop", inputFields: [{ key: "prompt", type: "string" }] },
  ]);
  const listed = await callMcpTool(grant, "cloving_status", {}, { service });
  assert.deepEqual(listed.structuredContent, {
    runs: [{ runId: "mine", workflowId: "develop" }],
    next: null,
  });
  assert.ok(
    !JSON.stringify([mcpTools(grant), workflows, listed]).includes(
      "private-workflow",
    ),
  );
});

test("MCP refuses undeclared tools, unknown arguments, and workflows outside the local grant", async () => {
  const sent = [];
  const ports = {
    service: async (request) => {
      sent.push(request);
      return service(request);
    },
  };
  for (const [name, args, error] of [
    [
      "cloving_run",
      { workflowId: "private-workflow", input: {}, commandId: "one" },
      "workflow-not-allowed",
    ],
    ["cloving_approve", {}, "tool-not-allowed"],
    ["execute_shell", { command: "anything" }, "tool-not-allowed"],
    [
      "cloving_run",
      {
        workflowId: "develop",
        input: {},
        commandId: "one",
        operation: "shell",
      },
      "arguments-invalid",
    ],
    [
      "cloving_run",
      { workflowId: "develop", input: [], commandId: "one" },
      "arguments-invalid",
    ],
    ["cloving_questions", {}, "arguments-invalid"],
    ["cloving_status", { runId: "private" }, "workflow-not-allowed"],
    ["cloving_events", { runId: "private" }, "workflow-not-allowed"],
  ]) {
    const reply = await callMcpTool(grant, name, args, ports);
    assert.equal(reply.isError, true, name);
    assert.equal(reply.structuredContent.error, error, name);
  }
  assert.deepEqual(
    sent.map((request) => request.operation),
    ["status", "status"],
  );
});

test("MCP starts a permitted workflow with literal inputs and returns live per-run status, questions, and events", async () => {
  const ports = { service };
  const input = { prompt: "secret literal; $()" };
  const started = await callMcpTool(
    grant,
    "cloving_run",
    { workflowId: "develop", input, commandId: "retry-one" },
    ports,
  );
  assert.deepEqual(started.structuredContent, {
    operation: "run",
    workflowId: "develop",
    source: "input",
    submission: input,
    commandId: "retry-one",
  });
  assert.equal(
    (await callMcpTool(grant, "cloving_status", { runId: "mine" }, ports))
      .structuredContent.run.state,
    "running",
  );
  assert.deepEqual(
    (await callMcpTool(grant, "cloving_questions", { runId: "mine" }, ports))
      .structuredContent,
    { operation: "questions", runId: "mine" },
  );
  assert.deepEqual(
    (
      await callMcpTool(
        grant,
        "cloving_events",
        { runId: "mine", after: 5 },
        ports,
      )
    ).structuredContent,
    { operation: "events", runId: "mine", after: 5 },
  );
});

test("MCP control and decision tools require explicit separate grants and retain revision and subject bindings", async () => {
  const allowed = {
    ...grant,
    permissions: [...grant.permissions, "control", "answer", "approve"],
  };
  assert.ok(mcpTools(allowed).some((tool) => tool.name === "cloving_approve"));
  const decisions = [
    {
      decisionId: "gate",
      runId: "mine",
      revision: 2,
      generation: 1,
      subjectDigest: `sha256:${"a".repeat(64)}`,
    },
  ];
  const ports = {
    service: (request) =>
      request.operation === "questions"
        ? Promise.resolve({ ok: true, result: { decisions } })
        : service(request),
  };
  const paused = await callMcpTool(
    allowed,
    "cloving_pause",
    { runId: "mine", expectedRevision: 2, commandId: "pause-one" },
    ports,
  );
  assert.deepEqual(paused.structuredContent, {
    operation: "run-command",
    command: "pause",
    runId: "mine",
    expectedRevision: 2,
    commandId: "pause-one",
  });
  const bound = {
    runId: "mine",
    reference: "gate",
    expectedRevision: 2,
    generation: 1,
    subjectDigest: decisions[0].subjectDigest,
    commandId: "approve-one",
  };
  const approved = await callMcpTool(allowed, "cloving_approve", bound, ports);
  assert.deepEqual(approved.structuredContent, {
    operation: "decision",
    command: "approve",
    reference: "gate",
    expectedRevision: 2,
    generation: 1,
    subjectDigest: decisions[0].subjectDigest,
    commandId: "approve-one",
  });
  assert.equal(
    (
      await callMcpTool(
        allowed,
        "cloving_approve",
        { ...bound, reference: "foreign-gate" },
        ports,
      )
    ).structuredContent.error,
    "decision-not-allowed",
  );
  assert.equal(
    (
      await callMcpTool(
        { ...allowed, permissions: ["control"] },
        "cloving_approve",
        bound,
        ports,
      )
    ).structuredContent.error,
    "tool-not-allowed",
  );
});

test("MCP accepts the long decision reference returned by native questions", async () => {
  const reference = `run/${"gate-".repeat(30)}`;
  const subjectDigest = `sha256:${"a".repeat(64)}`;
  const reply = await callMcpTool(
    { ...grant, permissions: ["approve"] },
    "cloving_approve",
    {
      runId: "mine",
      reference,
      expectedRevision: 1,
      generation: 1,
      subjectDigest,
      commandId: "approve",
    },
    {
      service: async (request) =>
        request.operation === "questions"
          ? {
              ok: true,
              result: {
                decisions: [
                  {
                    runId: "mine",
                    decisionId: reference,
                    revision: 1,
                    generation: 1,
                    subjectDigest,
                  },
                ],
              },
            }
          : service(request),
    },
  );
  assert.notEqual(reply.isError, true);
});

test("MCP mutation annotations acknowledge that workflows can change files and external systems", () => {
  const listed = mcpTools({
    ...grant,
    permissions: [...grant.permissions, "control"],
  });
  assert.equal(
    listed.find((tool) => tool.name === "cloving_run").annotations
      .openWorldHint,
    true,
  );
  assert.equal(
    listed.find((tool) => tool.name === "cloving_drop").annotations
      .destructiveHint,
    true,
  );
  assert.equal(
    listed.find((tool) => tool.name === "cloving_status").annotations
      .readOnlyHint,
    true,
  );
});

test("MCP event cursors are not forwarded to the status authorization preflight", async () => {
  const reply = await callMcpTool(
    grant,
    "cloving_events",
    { runId: "mine", after: 5 },
    {
      service: async (request) => {
        if (
          request.operation === "status" &&
          request.parameters.after !== undefined
        )
          return { ok: false, error: { code: "invalid-request" } };
        return service(request);
      },
    },
  );
  assert.notEqual(reply.isError, true);
  assert.equal(reply.structuredContent.after, 5);
});

test("MCP status scans past ungranted run pages and returns only a permitted continuation cursor", async () => {
  const requests = [];
  const reply = await callMcpTool(
    grant,
    "cloving_status",
    { limit: 1 },
    {
      service: async (request) => {
        requests.push(request);
        return {
          ok: true,
          result:
            request.parameters.after === "hidden"
              ? {
                  runs: [
                    { runId: "mine", workflowId: "develop" },
                    { runId: "later", workflowId: "develop" },
                  ],
                  next: null,
                }
              : {
                  runs: [{ runId: "hidden", workflowId: "private" }],
                  next: "hidden",
                },
        };
      },
    },
  );
  assert.deepEqual(reply.structuredContent, {
    runs: [{ runId: "mine", workflowId: "develop" }],
    next: "mine",
  });
  assert.equal(requests.length, 2);
  assert.ok(!JSON.stringify(reply).includes("hidden"));
});
