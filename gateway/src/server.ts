import express from "express";
import { createCcBridgeRouter } from "./ccp/router.ts";
import { createCcBridgeRuntime } from "./ccp/runtime.ts";

const port = Number(process.env.CCP_GATEWAY_PORT || 8787);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("CCP_GATEWAY_PORT must be a valid TCP port");
}
const host = process.env.CCP_GATEWAY_HOST || "127.0.0.1";
const containerLoopback = process.env.CCP_GATEWAY_CONTAINER_LOOPBACK === "1";
if (host !== "127.0.0.1" && host !== "::1" && !(host === "0.0.0.0" && containerLoopback)) {
  throw new Error("CCP_GATEWAY_HOST must be loopback; 0.0.0.0 requires explicit container loopback mode.");
}
const runtime = createCcBridgeRuntime();
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", "loopback");
app.use("/ccp", createCcBridgeRouter(runtime));
const server = app.listen(port, host, () => {
  console.log(`ccp gateway http://${host}:${port}/ccp/v1/health`);
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    runtime.store.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
