import { describe, expect, it } from "vitest";
import { createSigner } from "../../src/ccp/runtime.ts";

describe("CCP production signer isolation", () => {
  it("does not load PKCS8 bytes unless CCP_ALLOW_MEMORY_SIGNER=1", () => {
    const prev = {
      id: process.env.CCP_EXECUTION_KEY_ID,
      pkcs8: process.env.CCP_EXECUTION_PRIVATE_KEY_PKCS8,
      allow: process.env.CCP_ALLOW_MEMORY_SIGNER,
      socket: process.env.CCP_SIGNER_SOCKET,
    };
    try {
      delete process.env.CCP_SIGNER_SOCKET;
      delete process.env.CCP_ALLOW_MEMORY_SIGNER;
      process.env.CCP_EXECUTION_KEY_ID = "execution-prod-1";
      process.env.CCP_EXECUTION_PRIVATE_KEY_PKCS8 = "dGVzdA";
      expect(createSigner().keyId).toBe("unavailable");
    } finally {
      for (const [key, value] of Object.entries({
        CCP_EXECUTION_KEY_ID: prev.id,
        CCP_EXECUTION_PRIVATE_KEY_PKCS8: prev.pkcs8,
        CCP_ALLOW_MEMORY_SIGNER: prev.allow,
        CCP_SIGNER_SOCKET: prev.socket,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
