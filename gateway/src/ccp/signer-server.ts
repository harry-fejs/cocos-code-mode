import { sign as ed25519Sign, type KeyObject } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import {
  DECISION_PAYLOAD_MAX_BYTES,
  assertKeyId,
  decisionSignatureBase,
  decodeBase64Url,
  encodeBase64Url,
} from "./protocol.ts";

const SIGN_REQUEST_MAX_BYTES = DECISION_PAYLOAD_MAX_BYTES * 2;

export interface ExecutionSignerServerConfig {
  keyId: string;
  privateKey: KeyObject;
  maxSignaturesPerSecond: number;
}

interface SignRequest {
  keyId: string;
  message: string;
}

function parseSignRequest(bytes: Buffer): SignRequest {
  if (bytes.byteLength === 0 || bytes.byteLength > SIGN_REQUEST_MAX_BYTES) {
    throw new Error("request-size");
  }
  const value = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request-shape");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "keyId" || keys[1] !== "message") throw new Error("request-fields");
  if (typeof record.keyId !== "string" || typeof record.message !== "string") throw new Error("request-types");
  assertKeyId(record.keyId);
  return { keyId: record.keyId, message: record.message };
}

function send(socket: Socket, body: Record<string, string>): void {
  socket.end(JSON.stringify(body));
}

export function createExecutionSignerServer(config: ExecutionSignerServerConfig): Server {
  assertKeyId(config.keyId);
  if (!Number.isSafeInteger(config.maxSignaturesPerSecond) || config.maxSignaturesPerSecond <= 0) {
    throw new Error("maxSignaturesPerSecond must be a positive integer");
  }
  const expectedPrefix = decisionSignatureBase(config.keyId, Buffer.alloc(0));
  let rateWindowStartedAt = Date.now();
  let signaturesInWindow = 0;

  return createServer((socket) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let handled = false;

    socket.setTimeout(2_000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      receivedBytes += chunk.byteLength;
      if (receivedBytes > SIGN_REQUEST_MAX_BYTES) {
        handled = true;
        send(socket, { error: "request refused", code: "SIGNER_LIMIT" });
        return;
      }
      chunks.push(chunk);
      try {
        const request = parseSignRequest(Buffer.concat(chunks));
        if (request.keyId !== config.keyId) throw new Error("key-id");
        const message = decodeBase64Url(request.message, DECISION_PAYLOAD_MAX_BYTES + expectedPrefix.byteLength);
        if (
          message.byteLength <= expectedPrefix.byteLength ||
          !message.subarray(0, expectedPrefix.byteLength).equals(expectedPrefix)
        ) {
          throw new Error("domain-prefix");
        }
        const now = Date.now();
        if (now - rateWindowStartedAt >= 1_000) {
          rateWindowStartedAt = now;
          signaturesInWindow = 0;
        }
        if (signaturesInWindow >= config.maxSignaturesPerSecond) {
          handled = true;
          send(socket, { error: "request refused", code: "SIGNER_RATE" });
          return;
        }
        signaturesInWindow += 1;
        const signature = ed25519Sign(null, message, config.privateKey);
        handled = true;
        send(socket, { signature: encodeBase64Url(signature) });
      } catch (error) {
        if (error instanceof SyntaxError) return;
        handled = true;
        send(socket, { error: "request refused", code: "SIGNER_INVALID" });
      }
    });
    socket.on("error", () => socket.destroy());
  });
}
