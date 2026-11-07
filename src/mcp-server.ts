import type { Readable, Writable } from "node:stream";
import { object } from "./local.js";

const versions = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"];
const maximum = 1048576;
const serverInfo = { name: "cloving-encrypted-relay", version: "1.0.0" };

async function* frames(input: Readable): AsyncGenerator<string | undefined> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  for await (const raw of input) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    let start = 0;
    for (;;) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? undefined : end);
      bytes += part.length;
      if (bytes <= maximum) chunks.push(part);
      else chunks = [];
      if (end < 0) break;
      yield bytes <= maximum
        ? Buffer.concat(chunks).toString("utf8")
        : undefined;
      chunks = [];
      bytes = 0;
      start = end + 1;
    }
  }
  if (bytes > 0)
    yield bytes <= maximum ? Buffer.concat(chunks).toString("utf8") : undefined;
}

export async function serveMcp(
  client: {
    request: (
      method: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<Record<string, unknown>>;
  },
  ports: { input: Readable; output: Writable; signal?: AbortSignal },
): Promise<void> {
  const calls = new Map<string | number, AbortController>();
  const pending = new Set<Promise<void>>();
  const write = (value: unknown) => {
    ports.output.write(`${JSON.stringify(value)}\n`);
  };
  const error = (id: unknown, code: number, message: string, data?: unknown) =>
    write({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  const stop = () => {
    for (const call of calls.values()) call.abort();
    ports.input.destroy();
  };
  ports.signal?.addEventListener("abort", stop, { once: true });
  try {
    for await (const line of frames(ports.input)) {
      if (line === undefined) {
        error(null, -32600, "Message exceeds one MiB.");
        continue;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        error(null, -32700, "Parse error.");
        continue;
      }
      const request = object(decoded);
      const id = request.id;
      if (
        request.jsonrpc !== "2.0" ||
        typeof request.method !== "string" ||
        (Object.hasOwn(request, "id") &&
          typeof id !== "number" &&
          typeof id !== "string") ||
        (typeof id === "number" && !Number.isSafeInteger(id))
      ) {
        error(null, -32600, "Invalid request.");
        continue;
      }
      if (!Object.hasOwn(request, "id")) {
        const cancelled = object(request.params).requestId;
        if (
          request.method === "notifications/cancelled" &&
          (typeof cancelled === "string" || typeof cancelled === "number")
        )
          calls.get(cancelled)?.abort();
        continue;
      }
      if (typeof id !== "string" && typeof id !== "number") continue;
      if (
        request.params !== undefined &&
        (typeof request.params !== "object" ||
          request.params === null ||
          Array.isArray(request.params))
      ) {
        error(id, -32602, "Invalid parameters.");
        continue;
      }
      if (calls.has(id) || calls.size >= 32) {
        error(id, -32600, "Duplicate request ID or too many pending requests.");
        continue;
      }
      const params = object(request.params);
      const meta = object(params._meta);
      const version = meta["io.modelcontextprotocol/protocolVersion"];
      const modern =
        request.method === "server/discover" ||
        Object.hasOwn(meta, "io.modelcontextprotocol/protocolVersion") ||
        Object.hasOwn(meta, "io.modelcontextprotocol/clientCapabilities");
      if (modern) {
        if (
          typeof version !== "string" ||
          typeof meta["io.modelcontextprotocol/clientCapabilities"] !==
            "object" ||
          meta["io.modelcontextprotocol/clientCapabilities"] === null ||
          Array.isArray(meta["io.modelcontextprotocol/clientCapabilities"])
        ) {
          error(
            id,
            -32602,
            "Every modern request needs protocolVersion and clientCapabilities in _meta.",
          );
          continue;
        }
        if (!versions.includes(version)) {
          error(id, -32022, "Unsupported protocol version", {
            supported: versions,
            requested: version,
          });
          continue;
        }
      }
      const controller = new AbortController();
      calls.set(id, controller);
      const method = request.method;
      const execution = async () => {
        let result: Record<string, unknown>;
        if (method === "initialize")
          result = {
            protocolVersion: versions
              .slice(1)
              .includes(String(params.protocolVersion))
              ? params.protocolVersion
              : versions[1],
            capabilities: { tools: {} },
            serverInfo,
          };
        else if (method === "server/discover")
          result = {
            supportedVersions: versions,
            capabilities: { tools: {} },
            instructions:
              "Use cloving_workflows to discover locally permitted workflows. Mutations require a stable commandId for safe retries.",
          };
        else if (method === "ping") result = {};
        else if (method === "tools/list" || method === "tools/call") {
          try {
            result = await client.request(method, params, controller.signal);
            if (controller.signal.aborted) return;
            if (method === "tools/list" && !Array.isArray(result.tools)) {
              error(
                id,
                -32603,
                "MCP tools are unavailable. Check that the computer is online and approved.",
              );
              return;
            }
          } catch (failure) {
            if (controller.signal.aborted) return;
            const code =
              failure instanceof Error &&
              /^[a-z][a-z0-9-]{0,80}$/.test(failure.message)
                ? failure.message
                : "relay-unavailable";
            const text =
              code === "oauth-refresh-outcome-unknown"
                ? `${code}. Run cloving integrations unpair mcp --name NAME, then cloving integrations pair mcp --name NAME to reconnect safely.`
                : `${code}. Check that your Cloving computer is running and the connection is approved. A workflow command may already have taken effect; retry with the same commandId and arguments.`;
            if (method === "tools/list") {
              error(id, -32603, text);
              return;
            }
            result = {
              isError: true,
              structuredContent: { error: code },
              content: [{ type: "text", text }],
            };
          }
        } else {
          error(id, -32601, "Method not found.");
          return;
        }
        if (!controller.signal.aborted)
          write({
            jsonrpc: "2.0",
            id,
            result: modern
              ? {
                  ...result,
                  resultType: "complete",
                  _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
                  ...(["server/discover", "tools/list"].includes(method)
                    ? { ttlMs: 0, cacheScope: "private" }
                    : {}),
                }
              : result,
          });
      };
      const running = execution().finally(() => {
        calls.delete(id);
        pending.delete(running);
      });
      pending.add(running);
    }
  } catch (failure) {
    if (!ports.signal?.aborted) throw failure;
  } finally {
    await Promise.all(pending);
    ports.signal?.removeEventListener("abort", stop);
  }
}
