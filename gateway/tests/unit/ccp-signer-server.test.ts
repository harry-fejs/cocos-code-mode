import { generateKeyPairSync, randomUUID, verify as ed25519Verify, type KeyObject } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { decisionSignatureBase } from "../../src/ccp/protocol.ts";
import { createExecutionSignerServer } from "../../src/ccp/signer-server.ts";
import { UnixSocketSigner } from "../../src/ccp/unix-socket-signer.ts";

function signerPath(): string {
  const id = randomUUID();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\ccp-signer-${id}`
    : join(tmpdir(), `ccp-signer-${id}.sock`);
}

async function withSigner(
  maxSignaturesPerSecond: number,
  run: (signer: UnixSocketSigner, publicKey: KeyObject) => Promise<void>,
): Promise<void> {
  const keyId = "execution-test-1";
  const keys = generateKeyPairSync("ed25519");
  const socketPath = signerPath();
  const server = createExecutionSignerServer({
    keyId,
    privateKey: keys.privateKey,
    maxSignaturesPerSecond,
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  try {
    await run(new UnixSocketSigner(keyId, socketPath), keys.publicKey);
  } finally {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    if (process.platform !== "win32" && existsSync(socketPath)) unlinkSync(socketPath);
  }
}

describe("isolated execution signer service", () => {
  it("signs only the bound CCP decision domain", async () => {
    await withSigner(10, async (signer, publicKey) => {
      const message = decisionSignatureBase(signer.keyId, Buffer.from("{}"));
      const signature = await signer.sign(signer.keyId, message);
      expect(ed25519Verify(null, message, publicKey, signature)).toBe(true);
      await expect(signer.sign(signer.keyId, Buffer.from("wrong-domain"))).rejects.toThrow(/invalid signature payload/);
    });
  });

  it("enforces a signer-local rate bound", async () => {
    await withSigner(1, async (signer) => {
      const message = decisionSignatureBase(signer.keyId, Buffer.from("{}"));
      await signer.sign(signer.keyId, message);
      await expect(signer.sign(signer.keyId, message)).rejects.toThrow(/invalid signature payload/);
    });
  });
});
