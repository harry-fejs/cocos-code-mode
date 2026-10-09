import { createPrivateKey, createPublicKey, sign as ed25519Sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { signReleaseMetadata, verifyReleaseMetadata } from "../../src/ccp/release-metadata.ts";

const keys = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "ccp", "v1", "test-keys.json"), "utf8"));
const privateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });

describe("CCP release metadata", () => {
  it("verifies a threshold-1 target signature and rejects the wrong domain", () => {
    const body = { schemaVersion: 1, metadataVersion: 1, package: { sha256: "a".repeat(64), size: 1 } };
    const signed = signReleaseMetadata("target", "execution-fixture-1", body, privateKey);
    const keysById = new Map([["execution-fixture-1", publicKey]]);
    expect(verifyReleaseMetadata("target", signed, keysById, 1)).toEqual(body);
    expect(() => verifyReleaseMetadata("root", signed, keysById, 1)).toThrow("signature is invalid");
  });

  it("rejects duplicate, unknown, invalid-threshold, and non-canonical signed metadata", () => {
    const body = { schemaVersion: 1, metadataVersion: 2 };
    const signed = signReleaseMetadata("target", "execution-fixture-1", body, privateKey);
    const keysById = new Map([["execution-fixture-1", publicKey]]);
    expect(() => verifyReleaseMetadata("target", { ...signed, signatures: [signed.signatures[0], signed.signatures[0]] }, keysById, 1)).toThrow("duplicate signer");
    expect(() => verifyReleaseMetadata("target", { ...signed, signatures: [{ ...signed.signatures[0], keyId: "unknown-key-1" }] }, keysById, 1)).toThrow("unknown signer");
    expect(() => verifyReleaseMetadata("target", signed, keysById, 0)).toThrow("threshold is invalid");

    const payload = Buffer.from('{ \"metadataVersion\": 2, \"schemaVersion\": 1 }', "utf8");
    const signature = ed25519Sign(null, Buffer.concat([Buffer.from("CCP1 release-targets\n"), payload]), privateKey).toString("base64url");
    expect(() => verifyReleaseMetadata("target", {
      payload: payload.toString("base64url"),
      signatures: [{ keyId: "execution-fixture-1", signature }],
    }, keysById, 1)).toThrow("not canonical");
  });
});
