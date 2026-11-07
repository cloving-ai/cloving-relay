import { object } from "./local.js";
import type { Credential, Transport } from "./client.js";

export function relayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("relay-origin-invalid");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.origin !== value
  )
    throw new Error("relay-origin-invalid");
  return url.origin;
}

export function httpTransport(
  origin: string,
  token?: string,
  fetcher: typeof fetch = fetch,
): Transport {
  relayOrigin(origin);
  return async (method, path, body) => {
    if (
      !path.startsWith("/api/v1/relay/") ||
      new URL(path, origin).origin !== origin
    )
      throw new Error("relay-path-invalid");
    const response = await fetcher(`${origin}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`relay-status-${response.status}`);
    if (response.status === 204) return {};
    if (Number(response.headers.get("content-length")) > 10000000)
      throw new Error("relay-response-too-large");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("relay-response-invalid");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 10000000) throw new Error("relay-response-too-large");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("relay-response-invalid");
    }
  };
}

export function parseCredential(text: string): Credential {
  try {
    const value = object(
      JSON.parse(Buffer.from(text, "base64url").toString("utf8")),
    );
    const keys = object(value.keys);
    if (
      value.version !== 1 ||
      typeof value.origin !== "string" ||
      typeof value.connectionId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.connectionId) ||
      typeof value.token !== "string" ||
      !value.token ||
      typeof value.daemonAgreementPublicKey !== "string" ||
      typeof value.daemonSigningPublicKey !== "string" ||
      ![
        "agreementPrivateKey",
        "agreementPublicKey",
        "signingPrivateKey",
        "signingPublicKey",
      ].every((name) => typeof keys[name] === "string" && keys[name] !== "")
    )
      throw new Error("invalid");
    relayOrigin(value.origin);
    return value as unknown as Credential;
  } catch {
    throw new Error("credential-invalid");
  }
}
