import {
  version as platformVersion,
  type ZObject,
  type Bundle,
} from "zapier-platform-core";
import { Client, type Transport } from "./client.js";
import { parseCredential } from "./http.js";
import { object } from "./local.js";
import {
  OAUTH_ORIGIN,
  OAUTH_CLIENT_ID,
  getAccessToken,
  refreshAccessToken,
} from "./oauth.js";

function client(z: ZObject, bundle: Bundle): Client {
  const credential = parseCredential(bundle.authData.credential ?? "");
  const transport: Transport = async (method, path, body) => {
    const response = await z.request({
      url: `${credential.origin}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${bundle.authData.access_token ?? credential.token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeout: 10000,
      redirect: "error",
    });
    response.throwForStatus();
    return response.data;
  };
  return new Client(credential, transport);
}

async function workflows(z: ZObject, bundle: Bundle) {
  const catalog = (await client(z, bundle).read("catalog", "catalog"))[0];
  if (!Array.isArray(catalog?.workflows))
    throw new Error(
      "catalog-unavailable: Approve this connection on your computer and start the local Cloving Zapier adapter.",
    );
  return catalog.workflows.map(object);
}

async function inputFields(z: ZObject, bundle: Bundle) {
  if (!bundle.inputData.workflow_id) return [];
  const workflow = (await workflows(z, bundle)).find(
    (row) => row.id === bundle.inputData.workflow_id,
  );
  const fields = workflow?.inputFields;
  if (!Array.isArray(fields)) return [];
  return fields.map((value) => {
    const field = object(value);
    return {
      key: `field_${String(field.key)}`,
      label: String(field.key),
      type: "string" as const,
      required: false,
      helpText:
        field.required === true
          ? "Required by this workflow. You can also supply it in Input JSON."
          : "Optional workflow input.",
    };
  });
}

async function start(z: ZObject, bundle: Bundle) {
  let input: Record<string, unknown>;
  if (bundle.inputData.input_json) {
    const parsed: unknown = JSON.parse(String(bundle.inputData.input_json));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("input-invalid: Input JSON must be an object.");
    input = object(parsed);
  } else {
    input = Object.fromEntries(
      Object.entries(bundle.inputData)
        .filter(
          ([key, value]) =>
            key.startsWith("field_") && value !== undefined && value !== "",
        )
        .map(([key, value]) => [key.slice(6), value]),
    );
  }
  return client(z, bundle).start({
    workflowId: String(bundle.inputData.workflow_id),
    requestKey: String(bundle.inputData.request_key ?? ""),
    input,
  });
}

const runFields = [
  { key: "id", type: "string" },
  { key: "run_id", type: "string" },
  { key: "request_id", type: "string" },
  { key: "workflow_id", type: "string" },
  { key: "state", type: "string" },
  { key: "delivery_status", type: "string" },
  { key: "current_step", type: "string" },
  { key: "observed_at", type: "datetime" },
  { key: "error", type: "string" },
];

const app = {
  version: "2.0.0",
  platformVersion,
  authentication: {
    type: "oauth2",
    oauth2Config: {
      authorizeUrl: {
        url: `${OAUTH_ORIGIN}/oauth/zapier/authorize`,
        params: {
          client_id: OAUTH_CLIENT_ID,
          response_type: "code",
          scope: "workflow:start workflow:read",
        },
      },
      getAccessToken,
      refreshAccessToken,
      enablePkce: true,
      autoRefresh: true,
      scope: "workflow:start workflow:read",
    },
    fields: [
      {
        key: "credential",
        label: "Encryption credential",
        type: "password",
        computed: true,
      },
      {
        key: "pairing_code",
        label: "Pairing code",
        type: "string",
        computed: true,
        isNoSecret: true,
      },
      {
        key: "connection_name",
        label: "Computer",
        type: "string",
        computed: true,
        isNoSecret: true,
      },
    ],
    connectionLabel: "{{connection_name}} — pair {{pairing_code}}",
    test: async (z: ZObject, bundle: Bundle) => {
      const credential = parseCredential(bundle.authData.credential ?? "");
      if (bundle.authData.access_token) {
        const response = await z.request({
          url: `${credential.origin}/api/v1/relay/automation_connections/${credential.connectionId}`,
          method: "GET",
          headers: { Authorization: `Bearer ${bundle.authData.access_token}` },
          timeout: 10000,
          redirect: "error",
        });
        response.throwForStatus();
        if (object(response.data).connection_id !== credential.connectionId)
          throw new Error("oauth-connection-invalid");
      } else {
        await workflows(z, bundle);
      }
      return {
        connection_id: credential.connectionId,
      };
    },
  },
  creates: {
    start_workflow: {
      key: "start_workflow",
      noun: "Workflow Run",
      display: {
        label: "Start Workflow",
        description:
          "Queue an encrypted request to start an allowed workflow on your computer.",
      },
      operation: {
        inputFields: [
          {
            key: "workflow_id",
            label: "Workflow",
            required: true,
            dynamic: "workflows.id.name",
            altersDynamicFields: true,
          },
          {
            key: "request_key",
            label: "Request Key",
            required: true,
            helpText:
              "Map a unique source event ID. Replays with this key return the original run; reuse with different inputs is refused.",
          },
          inputFields,
          {
            key: "input_json",
            label: "Input JSON",
            type: "text",
            helpText:
              "Optional JSON object. When provided, this supplies all workflow inputs.",
          },
        ],
        perform: start,
        sample: {
          request_id: "example-request",
          run_id: null,
          delivery_status: "queued",
        },
        outputFields: runFields,
      },
    },
  },
  searches: {
    get_workflow_run: {
      key: "get_workflow_run",
      noun: "Workflow Run",
      display: {
        label: "Get Workflow Run",
        description:
          "Read the latest signed state of a permitted local workflow run.",
      },
      operation: {
        inputFields: [
          { key: "request_id", label: "Submission Request ID" },
          { key: "run_id", label: "Run ID" },
        ],
        perform: async (z: ZObject, bundle: Bundle) => {
          const requestId = bundle.inputData.request_id;
          const runId = bundle.inputData.run_id;
          if ((!requestId && !runId) || (requestId && runId))
            throw new Error(
              "run-reference-required: Supply exactly one request ID or run ID.",
            );
          const result = await client(z, bundle).run({
            ...(requestId
              ? { requestId: String(requestId) }
              : { runId: String(runId) }),
          });
          return [{ ...result, id: result.run_id ?? result.request_id }];
        },
        sample: {
          id: "example-run",
          run_id: "example-run",
          state: "running",
          observed_at: "2026-11-06T00:00:00Z",
        },
        outputFields: runFields,
      },
    },
  },
  triggers: {
    workflows: {
      key: "workflows",
      noun: "Workflow",
      display: {
        label: "Available Workflows",
        description:
          "List workflows that this computer allows Zapier to start.",
        hidden: true,
      },
      operation: {
        perform: workflows,
        sample: { id: "develop", name: "develop" },
        outputFields: [{ key: "id" }, { key: "name" }],
      },
    },
    run_state_changed: {
      key: "run_state_changed",
      noun: "Workflow Run",
      display: {
        label: "Workflow Run State Changed",
        description:
          "Triggers when a permitted local workflow run changes state.",
      },
      operation: {
        inputFields: [
          {
            key: "workflow_id",
            label: "Workflow",
            dynamic: "workflows.id.name",
            required: false,
          },
        ],
        perform: async (z: ZObject, bundle: Bundle) =>
          (await client(z, bundle).events()).filter(
            (event) =>
              !bundle.inputData.workflow_id ||
              event.workflow_id === bundle.inputData.workflow_id,
          ),
        sample: {
          id: "example-event",
          run_id: "example-run",
          workflow_id: "develop",
          state: "completed",
          observed_at: "2026-11-06T00:00:00Z",
        },
        outputFields: runFields,
      },
    },
  },
};

export default app;
