#!/usr/bin/env node
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { privateKey } = generateKeyPairSync("ed25519");
const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
const env = [
  "CCP_ALLOW_MEMORY_SIGNER=1",
  "CCP_EXECUTION_KEY_ID=execution-dev-1",
  `CCP_EXECUTION_PRIVATE_KEY_PKCS8=${pkcs8}`,
  "",
].join("\n");
writeFileSync(join(root, ".env"), env, { mode: 0o600 });
console.log("wrote gateway/.env with a local memory signer (not for production)");
