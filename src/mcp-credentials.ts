import { mkdir, open, chmod } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./runtime.js";
import { object } from "./local.js";
import { parseCredential, httpTransport } from "./http.js";
import { refreshMcpCredential, type McpCredential } from "./mcp-auth.js";
import type { Transport } from "./client.js";

async function locked<T>(
  store: Store,
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const path = join(store.directory, `.${name}.refresh.sqlite3`);
  await mkdir(store.directory, { recursive: true, mode: 0o700 });
  const file = await open(path, "a", 0o600);
  await file.close();
  await chmod(path, 0o600);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  let acquired = false;
  try {
    const deadline = Date.now() + 15000;
    while (!acquired) {
      try {
        db.exec("BEGIN IMMEDIATE");
        acquired = true;
      } catch (error) {
        if (object(error).errcode !== 5 || Date.now() >= deadline)
          throw new Error("oauth-refresh-busy");
        await delay(25);
      }
    }
    return await task();
  } finally {
    if (acquired) db.exec("ROLLBACK");
    db.close();
  }
}

async function load(
  store: Store,
  name: string,
): Promise<{ credential: McpCredential; pending: boolean }> {
  const value = await store.read(name);
  if (
    !value ||
    value.integration !== "mcp" ||
    value.revokedAt ||
    typeof value.refreshToken !== "string" ||
    typeof value.expiresAt !== "number" ||
    !Number.isFinite(value.expiresAt)
  )
    throw new Error("connection-unknown");
  const credential = parseCredential(
    Buffer.from(JSON.stringify(value)).toString("base64url"),
  );
  return {
    credential: {
      ...credential,
      integration: "mcp",
      refreshToken: value.refreshToken,
      expiresAt: value.expiresAt,
      refreshPending: value.refreshPending === true,
    },
    pending: value.refreshPending === true,
  };
}

export async function credentialTransport(
  store: Store,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<{ credential: McpCredential; transport: Transport }> {
  const initial = (await load(store, name)).credential;
  const current = async (waiting = false) => {
    const saved = await load(store, name);
    if (
      saved.credential.connectionId !== initial.connectionId ||
      saved.credential.keys.signingPublicKey !==
        initial.keys.signingPublicKey ||
      saved.credential.keys.agreementPublicKey !==
        initial.keys.agreementPublicKey ||
      saved.credential.daemonAgreementPublicKey !==
        initial.daemonAgreementPublicKey ||
      saved.credential.daemonSigningPublicKey !== initial.daemonSigningPublicKey
    )
      throw new Error("oauth-peer-changed");
    if (saved.pending && !waiting)
      throw new Error("oauth-refresh-outcome-unknown");
    return saved.credential;
  };
  const refresh = async (previousToken: string) =>
    locked(store, name, async () => {
      const credential = await current();
      if (
        credential.token !== previousToken &&
        credential.expiresAt > Date.now() + 30000
      )
        return credential;
      await store.write(name, { ...credential, refreshPending: true });
      const updated = await refreshMcpCredential(credential, fetcher);
      await store.write(name, { ...updated, refreshPending: false });
      return updated;
    });
  const transport: Transport = async (method, path, body) => {
    let credential = await current(true);
    if (credential.refreshPending || credential.expiresAt <= Date.now() + 30000)
      credential = await refresh(credential.token);
    try {
      return await httpTransport(credential.origin, credential.token, fetcher)(
        method,
        path,
        body,
      );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "relay-status-401")
        throw error;
      credential = await refresh(credential.token);
      return httpTransport(credential.origin, credential.token, fetcher)(
        method,
        path,
        body,
      );
    }
  };
  return { credential: initial, transport };
}

export async function unpairMcpCredential(
  store: Store,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  await locked(store, name, async () => {
    const { credential } = await load(store, name);
    const response = await fetcher(`${credential.origin}/oauth/mcp/revoke`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cloving-mcp",
        token: credential.token,
      }),
    });
    if (!response.ok) throw new Error("oauth-revocation-failed");
    await store.remove(name);
  });
}
