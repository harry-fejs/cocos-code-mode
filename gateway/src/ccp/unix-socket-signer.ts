import { connect } from "node:net";
import { CcpError } from "./errors.ts";
import { DECISION_PAYLOAD_MAX_BYTES, ED25519_SIGNATURE_BYTES, assertKeyId, decodeBase64Url } from "./protocol.ts";
import type { EnvelopeSigner } from "./envelope-signer.ts";

function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class UnixSocketSigner implements EnvelopeSigner {
  constructor(
    readonly keyId: string,
    private readonly socketPath: string,
  ) {
    assertKeyId(keyId);
    if (!socketPath.startsWith("/") && !socketPath.startsWith("\\\\.\\pipe\\")) {
      throw new Error("execution signer socket path must be a Unix socket or Windows pipe");
    }
  }

  async sign(keyId: string, message: Uint8Array): Promise<Buffer> {
    assertKeyId(keyId);
    if (keyId !== this.keyId) throw new CcpError("CCP_INTERNAL", "Signer refused an unknown execution key ID.");
    if (message.byteLength === 0 || message.byteLength > DECISION_PAYLOAD_MAX_BYTES + 64) {
      throw new CcpError("CCP_LIMIT_EXCEEDED", "Signer refused an oversized decision message.");
    }
    const { promise, resolve, reject } = withResolvers<Buffer>();
    const socket = connect(this.socketPath);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CcpError("CCP_GATEWAY_UNAVAILABLE", "Execution signer socket timed out."));
    }, 2_000);
    let settled = false;
    const finish = (error?: unknown, signature?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (signature) resolve(signature);
      else reject(error ?? new CcpError("CCP_GATEWAY_UNAVAILABLE", "Execution signer returned an invalid signature payload."));
    };
    socket.on("connect", () => {
      socket.write(JSON.stringify({ keyId, message: Buffer.from(message).toString("base64url") }));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { signature?: unknown };
        if (typeof body.signature !== "string") return;
        finish(undefined, decodeBase64Url(body.signature, ED25519_SIGNATURE_BYTES, ED25519_SIGNATURE_BYTES));
      } catch {
        /* wait for more bytes */
      }
    });
    socket.on("error", (error) => finish(new CcpError("CCP_GATEWAY_UNAVAILABLE", "Execution signer socket failed.", { reason: error.message })));
    socket.on("end", () => finish());
    return promise;
  }
}
