import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { newIdentity } from "./identity.js";
import { object } from "./local.js";
import { parseCredential, relayOrigin } from "./http.js";
import type { Credential } from "./client.js";

export interface McpCredential extends Credential {
  readonly refreshPending?: boolean;
  readonly integration: "mcp";
  readonly refreshToken: string;
  readonly expiresAt: number;
}

async function tokenRequest(
  origin: string,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${relayOrigin(origin)}/oauth/mcp/token`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ ...body, client_id: "cloving-mcp" }),
  });
  if (!response.ok) throw new Error("oauth-authorization-failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("oauth-response-invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 65536) throw new Error("oauth-response-invalid");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (
    ![
      "access_token",
      "refresh_token",
      "connection_id",
      "daemon_agreement_public_key",
      "daemon_signing_public_key",
    ].every((key) => typeof result[key] === "string" && result[key] !== "") ||
    typeof result.expires_in !== "number" ||
    result.expires_in < 1 ||
    result.expires_in > 3600
  )
    throw new Error("oauth-response-invalid");
  return result;
}

export async function pairMcp(
  origin: string,
  ports: {
    authorize: (url: string) => Promise<unknown>;
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<McpCredential> {
  relayOrigin(origin);
  const keys = newIdentity();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  let accept!: (code: string) => void;
  let refuse!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  received.catch(() => undefined);
  let redirect = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    const url = new URL(request.url ?? "/", redirect);
    const supplied = Buffer.from(url.searchParams.get("state") ?? "");
    if (
      request.method !== "GET" ||
      url.pathname !== "/callback" ||
      request.headers.host !== new URL(redirect).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      supplied.length !== state.length ||
      !timingSafeEqual(supplied, Buffer.from(state))
    ) {
      response
        .writeHead(400)
        .end(
          "This callback does not match the connection. Return to your pairing terminal.",
        );
      return;
    }
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error")) {
      response.end("Connection cancelled. You can close this tab.");
      refuse(new Error("oauth-cancelled"));
    } else if (code && /^[A-Za-z0-9_-]{1,128}$/.test(code)) {
      response.end(
        "Signed in. Return to the harness terminal for your pairing code. Your Cloving computer still needs to approve it.",
      );
      accept(code);
    } else response.writeHead(400).end("Missing authorization code.");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("oauth-callback-unavailable");
  redirect = `http://127.0.0.1:${address.port}/callback`;
  const url = new URL(`${origin}/oauth/mcp/authorize`);
  url.search = new URLSearchParams({
    client_id: "cloving-mcp",
    redirect_uri: redirect,
    response_type: "code",
    scope: "workflow:start workflow:read",
    state,
    code_challenge_method: "S256",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  }).toString();
  const timer = setTimeout(
    () => refuse(new Error("oauth-pairing-timeout")),
    180000,
  );
  const abort = () => refuse(new Error("oauth-cancelled"));
  ports.signal?.addEventListener("abort", abort, { once: true });
  try {
    ports.signal?.throwIfAborted();
    await ports.authorize(url.href);
    const code = await received;
    const tokens = await tokenRequest(
      origin,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirect,
        agreement_public_key: keys.agreementPublicKey,
        signing_public_key: keys.signingPublicKey,
      },
      ports.fetcher ?? fetch,
    );
    const credential = parseCredential(
      Buffer.from(
        JSON.stringify({
          version: 1,
          origin,
          connectionId: tokens.connection_id,
          token: tokens.access_token,
          keys,
          daemonAgreementPublicKey: tokens.daemon_agreement_public_key,
          daemonSigningPublicKey: tokens.daemon_signing_public_key,
        }),
      ).toString("base64url"),
    );
    return {
      ...credential,
      integration: "mcp",
      refreshToken: String(tokens.refresh_token),
      expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
    };
  } finally {
    clearTimeout(timer);
    ports.signal?.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function refreshMcpCredential(
  credential: McpCredential,
  fetcher: typeof fetch = fetch,
): Promise<McpCredential> {
  const tokens = await tokenRequest(
    credential.origin,
    { grant_type: "refresh_token", refresh_token: credential.refreshToken },
    fetcher,
  );
  if (
    tokens.connection_id !== credential.connectionId ||
    tokens.daemon_agreement_public_key !==
      credential.daemonAgreementPublicKey ||
    tokens.daemon_signing_public_key !== credential.daemonSigningPublicKey
  )
    throw new Error("oauth-peer-changed");
  return {
    ...credential,
    token: String(tokens.access_token),
    refreshToken: String(tokens.refresh_token),
    expiresAt: Date.now() + Number(tokens.expires_in) * 1000,
  };
}
