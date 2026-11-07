import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Keys } from "./protocol.js";

function point(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  return Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64url");
}

export function newIdentity(): Keys {
  const pair = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const agreement = pair();
  const signing = pair();
  return {
    agreementPrivateKey: agreement.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
    agreementPublicKey: point(agreement.publicKey),
    signingPrivateKey: signing.privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64url"),
    signingPublicKey: point(signing.publicKey),
  };
}
