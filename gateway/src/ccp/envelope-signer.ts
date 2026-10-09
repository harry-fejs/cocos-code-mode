import { KeyLike, sign as ed25519Sign } from "node:crypto";
import { CcpError } from "./errors.ts";
import { DECISION_PAYLOAD_MAX_BYTES, ED25519_SIGNATURE_BYTES, assertKeyId, encodeBase64Url } from "./protocol.ts";

export interface EnvelopeSigner {
  keyId: string;
  sign(keyId: string, message: Uint8Array): Promise<Buffer>;
}

export class MemoryEnvelopeSigner implements EnvelopeSigner {
  constructor(
    readonly keyId: string,
    private readonly privateKey: KeyLike,
  ) {}

  async sign(keyId: string, message: Uint8Array): Promise<Buffer> {
    assertKeyId(keyId);
    if (keyId !== this.keyId) throw new CcpError("CCP_INTERNAL", "Signer refused an unknown execution key ID.");
    if (message.byteLength === 0 || message.byteLength > DECISION_PAYLOAD_MAX_BYTES + 64) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Signer refused an oversized decision message.");
    }
    const signature = ed25519Sign(null, message, this.privateKey);
    if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
      throw new CcpError("CCP_INTERNAL", "Signer produced an invalid signature length.");
    }
    return signature;
  }
}

export function encodeSignature(signature: Buffer): string {
  return encodeBase64Url(signature);
}
