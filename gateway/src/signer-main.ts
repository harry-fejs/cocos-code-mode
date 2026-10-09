import { createPrivateKey } from "node:crypto";
import { chmodSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { createExecutionSignerServer } from "./ccp/signer-server.ts";

const socketPath = process.env.CCP_SIGNER_SOCKET;
const keyId = process.env.CCP_EXECUTION_KEY_ID;
const privateKeyPath = process.env.CCP_SIGNER_PRIVATE_KEY_PATH;
if (!socketPath || !keyId || !privateKeyPath) {
  throw new Error("CCP_SIGNER_SOCKET, CCP_EXECUTION_KEY_ID, and CCP_SIGNER_PRIVATE_KEY_PATH are required");
}
const signerSocketPath: string = socketPath;
if (!signerSocketPath.startsWith("/") && !signerSocketPath.startsWith("\\\\.\\pipe\\")) {
  throw new Error("CCP_SIGNER_SOCKET must be an absolute Unix socket or Windows named pipe");
}
const maxPerSecond = Number(process.env.CCP_SIGNER_MAX_PER_SECOND ?? "1000");
if (!Number.isSafeInteger(maxPerSecond) || maxPerSecond <= 0) {
  throw new Error("CCP_SIGNER_MAX_PER_SECOND must be a positive integer");
}

process.umask(0o077);
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("Execution signer private key must be Ed25519");
}
if (signerSocketPath.startsWith("/") && existsSync(signerSocketPath)) unlinkSync(signerSocketPath);

const server = createExecutionSignerServer({
  keyId,
  privateKey,
  maxSignaturesPerSecond: maxPerSecond,
});
server.listen(signerSocketPath, () => {
  if (signerSocketPath.startsWith("/")) chmodSync(signerSocketPath, 0o600);
  console.log(`ccp execution signer ready on ${signerSocketPath}`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    if (signerSocketPath.startsWith("/") && existsSync(signerSocketPath)) unlinkSync(signerSocketPath);
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
