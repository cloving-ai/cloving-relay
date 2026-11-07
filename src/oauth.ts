import { createHash } from "node:crypto";
import type { ZObject, Bundle } from "zapier-platform-core";
import { newIdentity } from "./identity.js";
import { parseCredential } from "./http.js";
import { object } from "./local.js";

export const OAUTH_ORIGIN = "https://cloving.ai";
export const OAUTH_CLIENT_ID = "cloving-zapier";

export function pairingCode(binding: {
  origin: string;
  connectionId: string;
  daemonAgreementPublicKey: string;
  daemonSigningPublicKey: string;
  clientAgreementPublicKey: string;
  clientSigningPublicKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "cloving-zapier-pairing-v1",
        binding.origin,
        binding.connectionId,
        binding.daemonAgreementPublicKey,
        binding.daemonSigningPublicKey,
        binding.clientAgreementPublicKey,
        binding.clientSigningPublicKey,
      ]),
    )
    .digest("hex")
    .slice(0, 20)
    .toUpperCase();
  return digest.match(/.{4}/g)!.join("-");
}

async function tokenRequest(z: ZObject, body: Record<string, unknown>) {
  const response = await z.request({
    url: `${OAUTH_ORIGIN}/oauth/zapier/token`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeout: 10000,
    redirect: "error",
  });
  response.throwForStatus();
  const result = object(response.data);
  for (const key of [
    "access_token",
    "refresh_token",
    "connection_id",
    "daemon_agreement_public_key",
    "daemon_signing_public_key",
  ]) {
    if (typeof result[key] !== "string" || !result[key])
      throw new Error("oauth-response-invalid");
  }
  return result;
}

export async function getAccessToken(z: ZObject, bundle: Bundle) {
  const keys = newIdentity();
  const result = await tokenRequest(z, {
    grant_type: "authorization_code",
    client_id: OAUTH_CLIENT_ID,
    code: bundle.inputData.code,
    code_verifier: bundle.inputData.code_verifier,
    redirect_uri: bundle.inputData.redirect_uri,
    agreement_public_key: keys.agreementPublicKey,
    signing_public_key: keys.signingPublicKey,
  });
  const credential = Buffer.from(
    JSON.stringify({
      version: 1,
      origin: OAUTH_ORIGIN,
      connectionId: result.connection_id,
      token: "oauth",
      keys,
      daemonAgreementPublicKey: result.daemon_agreement_public_key,
      daemonSigningPublicKey: result.daemon_signing_public_key,
    }),
  ).toString("base64url");
  const parsed = parseCredential(credential);
  return {
    ...result,
    credential,
    pairing_code: pairingCode({
      origin: parsed.origin,
      connectionId: parsed.connectionId,
      daemonAgreementPublicKey: parsed.daemonAgreementPublicKey,
      daemonSigningPublicKey: parsed.daemonSigningPublicKey,
      clientAgreementPublicKey: keys.agreementPublicKey,
      clientSigningPublicKey: keys.signingPublicKey,
    }),
  };
}

export async function refreshAccessToken(z: ZObject, bundle: Bundle) {
  const credential = parseCredential(bundle.authData.credential ?? "");
  const result = await tokenRequest(z, {
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: bundle.authData.refresh_token,
  });
  if (
    result.connection_id !== credential.connectionId ||
    result.daemon_agreement_public_key !==
      credential.daemonAgreementPublicKey ||
    result.daemon_signing_public_key !== credential.daemonSigningPublicKey
  ) {
    throw new Error("oauth-peer-changed");
  }
  return {
    ...result,
    credential: bundle.authData.credential,
    pairing_code: bundle.authData.pairing_code,
  };
}
