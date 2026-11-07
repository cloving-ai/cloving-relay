import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface Keys {
  readonly agreementPrivateKey: string;
  readonly agreementPublicKey: string;
  readonly signingPrivateKey: string;
  readonly signingPublicKey: string;
}

export interface Binding {
  readonly connectionId: string;
  readonly direction: "request" | "response";
}

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const info = Buffer.from("cloving-automation-v1");

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`,
      )
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("message-invalid");
  return encoded;
}

function privateKey(value: string) {
  return createPrivateKey({
    key: Buffer.from(value, "base64url"),
    type: "pkcs8",
    format: "der",
  });
}

function publicKey(value: string) {
  const point = Buffer.from(value, "base64url");
  if (point.length !== 65 || point[0] !== 4) throw new Error("key-invalid");
  return createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  });
}

function aad(binding: Binding): Buffer {
  return Buffer.from(
    `cloving-automation-v1|${binding.connectionId}|${binding.direction}`,
  );
}

export async function sealMessage(
  keys: Keys,
  recipient: string,
  binding: Binding,
  value: unknown,
): Promise<string> {
  const payload = canonical(value);
  const signature = sign("sha256", Buffer.from(payload), {
    key: privateKey(keys.signingPrivateKey),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const plaintext = Buffer.from(canonical({ payload, signature }));
  const length = [1024, 4096, 16384, 65536].find(
    (size) => plaintext.length < size,
  );
  if (length === undefined) throw new Error("message-too-large");
  const padded = Buffer.alloc(length);
  plaintext.copy(padded);
  padded[plaintext.length] = 128;
  const recipientPublicKey = await suite.kem.importKey(
    "jwk",
    publicKey(recipient).export({ format: "jwk" }),
    true,
  );
  const sealed = await suite.seal(
    { recipientPublicKey, info },
    padded,
    aad(binding),
  );
  return Buffer.concat([
    Buffer.from(sealed.enc),
    Buffer.from(sealed.ct),
  ]).toString("base64url");
}

export async function openMessage(
  keys: Keys,
  sender: string,
  binding: Binding,
  ciphertext: string,
): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_-]+$/.test(ciphertext)) throw new Error("message-invalid");
  const sealed = Buffer.from(ciphertext, "base64url");
  if (![1105, 4177, 16465, 65617].includes(sealed.length))
    throw new Error("message-size-invalid");
  const recipientKey = await suite.kem.importKey(
    "jwk",
    privateKey(keys.agreementPrivateKey).export({ format: "jwk" }),
    false,
  );
  const padded = Buffer.from(
    await suite.open(
      { recipientKey, enc: sealed.subarray(0, 65), info },
      sealed.subarray(65),
      aad(binding),
    ),
  );
  const end = padded.findLastIndex((byte) => byte !== 0);
  if (padded[end] !== 128) throw new Error("message-padding-invalid");
  const signed = JSON.parse(padded.subarray(0, end).toString("utf8"));
  if (
    typeof signed.payload !== "string" ||
    typeof signed.signature !== "string" ||
    !verify(
      "sha256",
      Buffer.from(signed.payload),
      { key: publicKey(sender), dsaEncoding: "ieee-p1363" },
      Buffer.from(signed.signature, "base64url"),
    )
  )
    throw new Error("message-signature-invalid");
  const value: unknown = JSON.parse(signed.payload);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("message-invalid");
  return value as Record<string, unknown>;
}
