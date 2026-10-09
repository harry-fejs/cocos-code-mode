import { createPrivateKey, createPublicKey, sign as ed25519Sign, verify as ed25519Verify } from "node:crypto";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UnixSocketSigner } from "../../src/ccp/unix-socket-signer.ts";
import { decisionSignatureBase } from "../../src/ccp/protocol.ts";

const keys = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "ccp", "v1", "test-keys.json"), "utf8"));
const privateKey = createPrivateKey({ key: Buffer.from(keys.execution.privateKeyPkcs8, "base64url"), format: "der", type: "pkcs8" });
const publicKey = createPublicKey({ key: Buffer.from(keys.execution.publicKeySpki, "base64url"), format: "der", type: "spki" });

describe("Unix socket execution signer", () => {
  it("signs only the admitted key and domain-separated message", async () => {
    const path = process.platform === "win32" ? `\\\\.\\pipe\\ccp-signer-test-${process.pid}` : `/tmp/ccp-signer-test-${process.pid}.sock`;
    const server = createServer((socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        try {
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { keyId: string; message: string };
          const message = Buffer.from(request.message, "base64url");
          const signature = ed25519Sign(null, message, privateKey);
          socket.end(JSON.stringify({ signature: signature.toString("base64url") }));
        } catch {
          /* wait for more bytes */
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(path, () => resolve());
      server.once("error", reject);
    });
    try {
      const signer = new UnixSocketSigner("execution-fixture-1", path);
      const message = decisionSignatureBase("execution-fixture-1", Buffer.from("fixture-decision"));
      const signature = await signer.sign("execution-fixture-1", message);
      expect(ed25519Verify(null, message, publicKey, signature)).toBe(true);
      await expect(signer.sign("other-key", message)).rejects.toThrow("unknown execution key");
    } finally {
      server.close();
    }
  });
});
