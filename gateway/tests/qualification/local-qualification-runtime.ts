import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { Agent, createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { SignJWT } from "jose";
import { createMemberTokenVerifier, type AuthContext } from "../../src/auth.ts";
import { createGatewayAdmission, loadAdmissionConfig } from "../../src/ccp/admission.ts";
import { createMemberAuthMiddleware } from "../../src/ccp/auth-middleware.ts";
import { canonicalizeToBytes } from "../../src/ccp/canonical-json.ts";
import { MemoryEnvelopeSigner } from "../../src/ccp/envelope-signer.ts";
import { type ExecuteDependencies } from "../../src/ccp/execute-service.ts";
import { planCreateUiNode } from "../../src/ccp/planners/create-ui-node.ts";
import { planCommands } from "../../src/ccp/planners/planner-helpers.ts";
import { ProtectedToolRegistry } from "../../src/ccp/protected-tool-registry.ts";
import { signProtectedRequest, type ProtectedRequest } from "../../src/ccp/protocol.ts";
import { ReplayStore } from "../../src/ccp/replay-store.ts";
import { createCcBridgeRouter } from "../../src/ccp/router.ts";
import { CcBridgeStore } from "../../src/ccp/store.ts";
import { PUBLIC_TOOL_BY_NAME } from "../../src/ccp/tool-catalog.ts";
import { ReplayWindow } from "../../../source/protected/replay-window.ts";
import { verifyDecision } from "../../../source/protected/decision-verifier.ts";
import { executeEnvelope } from "../../../source/protected/primitive-executor.ts";
import type { IJson } from "../../../source/protected/canonical-json.ts";
import { Evidence, errorCode, invariant, sha256 } from "./local-qualification-evidence.ts";

export const tool = PUBLIC_TOOL_BY_NAME.createUiNode;
export class QualificationClient {
  readonly deviceId = randomUUID();
  readonly instanceId = randomUUID();
  readonly projectId = randomUUID();
  readonly keyId: string;
  readonly keys = generateKeyPairSync("ed25519");
  readonly replay = new ReplayWindow();
  readonly relay: ProtectedRequest["relay"];
  readonly auth: AuthContext;
  token = "";
  agent = new Agent({ keepAlive: true, maxSockets: 1 });
  constructor(index: number, sourceHash: string) {
    this.keyId = `qualification-device-${index}`;
    this.relay = Object.freeze({ build: "2.0.0-local-qualification", packageHash: sourceHash, creatorVersion: "3.7.3", os: "win32-x64" });
    this.auth = { member_id: `qualification-member-${index}`, label: "local qualification", jti: randomUUID(), is_legacy: false,
      role: "admin", clearance: "restricted", products: ["ccp"], tokenAlg: "EdDSA", exp: Math.floor(Date.now() / 1000) + 86_400 };
  }
  reconnect(): void {
    this.agent.destroy();
    this.agent = new Agent({ keepAlive: true, maxSockets: 1 });
  }
}

export class QualificationRuntime {
  readonly directory = mkdtempSync(join(tmpdir(), "ccp-local-qualification-"));
  store = new CcBridgeStore(join(this.directory, "gateway.sqlite"));
  readonly memberKeys = generateKeyPairSync("ed25519");
  readonly executionKeys = generateKeyPairSync("ed25519");
  readonly clients: QualificationClient[];
  readonly deps: ExecuteDependencies;
  readonly admissionConfig = { ...loadAdmissionConfig({}), ipRequestsPerMinute: 60_000, memberRequestsPerMinute: 1200 };
  private server?: Server;
  private port = 0;
  requests = 0;
  active = 0;
  maxActive = 0;
  constructor(readonly evidence: Evidence, count: number) {
    this.clients = Array.from({ length: count }, (_, index) => new QualificationClient(index, evidence.identity.relaySourceSha256));
    this.deps = { store: this.store, replay: new ReplayStore(this.store.db), signer: new MemoryEnvelopeSigner("qualification-execution", this.executionKeys.privateKey), planners: new ProtectedToolRegistry() };
    this.deployPlanner(false);
    this.store.insertOperationPolicy({ toolId: tool.name, contractVersion: tool.contractVersion, contractHash: tool.contractHash,
      enabled: true, minimumRelayBuild: "2.0.0", blockedRelayBuilds: [], creatorRange: tool.creatorRange,
      requiredConsentVersion: tool.operations["*"].observation.consentVersion, revision: 1 });
    for (const client of this.clients) {
      const spki = client.keys.publicKey.export({ format: "der", type: "spki" });
      this.store.insertDevice({ id: client.deviceId, keyId: client.keyId, memberId: client.auth.member_id,
        publicKeySpki: spki, fingerprint: sha256(spki), label: "simulated-client", status: "approved" });
      this.store.insertProject({ id: client.projectId, displayLabel: "simulated-project", status: "active" });
      this.store.insertGrant({ id: randomUUID(), memberId: client.auth.member_id, deviceId: client.deviceId,
        projectId: client.projectId, toolId: tool.name, operationClass: "mutation", expiresAtMs: null, status: "active" });
    }
  }
  deployPlanner(defect: boolean): void {
    const registry = new ProtectedToolRegistry();
    registry.register(tool.name, tool.contractVersion, defect ? (context) => {
      // Controlled server-only defect: ignore the caller's requested name. The
      // actual planner helpers, validator, signer and clients remain unchanged.
      const decision = planCreateUiNode(context);
      invariant(decision.kind === "execute", "EXPECTED_EXECUTE_DECISION");
      const command = decision.envelope.commands[0];
      invariant(command.op === "scene.createNode", "EXPECTED_CREATE_COMMAND");
      command.args.name = { source: "request", jsonPointer: "/inputs/uiType" };
      return planCommands(context, [command], [command.commandId]);
    } : planCreateUiNode);
    this.deps.planners = registry;
  }
  async start(): Promise<void> {
    for (const client of this.clients) client.token = await new SignJWT({ label: client.auth.label, role: "admin", products: ["ccp"] })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT" }).setIssuer("local-qualification").setSubject(client.auth.member_id)
      .setJti(client.auth.jti).setIssuedAt().setExpirationTime(client.auth.exp).sign(this.memberKeys.privateKey);
    const verifier = createMemberTokenVerifier({ issuer: "local-qualification", publicKeyPem: this.memberKeys.publicKey.export({ format: "pem", type: "spki" }).toString() });
    const app = express();
    app.use("/ccp/v1/execute", (_req, res, next) => {
      this.requests += 1; this.active += 1; this.maxActive = Math.max(this.maxActive, this.active);
      let finished = false;
      const finish = () => { if (!finished) { this.active -= 1; finished = true; } };
      res.once("finish", finish); res.once("close", finish); next();
    });
    app.use("/ccp", createCcBridgeRouter(this.deps, createMemberAuthMiddleware(verifier), createGatewayAdmission(this.admissionConfig)));
    this.server = createServer(app);
    const listening = Promise.withResolvers<void>();
    this.server.once("error", listening.reject);
    this.server.listen(0, "127.0.0.1", listening.resolve);
    await listening.promise;
    const address = this.server.address();
    invariant(address && typeof address !== "string", "NO_LOOPBACK_ADDRESS"); this.port = address.port;
  }
  async stop(): Promise<void> {
    for (const client of this.clients) client.agent.destroy();
    if (this.server) {
      const closed = Promise.withResolvers<void>();
      this.server.close((error) => error ? closed.reject(error) : closed.resolve());
      this.server.closeAllConnections();
      await closed.promise;
    }
  }
  async restart(): Promise<void> {
    await this.stop(); this.store.close();
    this.store = new CcBridgeStore(join(this.directory, "gateway.sqlite"));
    this.deps.store = this.store; this.deps.replay = new ReplayStore(this.store.db);
    for (const client of this.clients) client.reconnect();
    await this.start();
  }
  async close(): Promise<void> {
    await this.stop(); this.store.close(); rmSync(this.directory, { recursive: true, force: true });
  }
  async call(client: QualificationClient, scenario: string, expectedStatus = 200, expectedCode?: string): Promise<{ latencyMs: number; nameHash?: string; gatewayMs?: number }> {
    const started = performance.now();
    const fields = { parentReference: null, sceneRoot: "simulated-scene-root" };
    const request: ProtectedRequest = { protocolVersion: 1, requestId: randomUUID(), idempotencyKey: randomUUID(), deviceId: client.deviceId,
      projectId: client.projectId, relayInstanceId: client.instanceId, sequence: client.replay.nextSequence(), issuedAtMs: Date.now(),
      nonce: randomBytes(16).toString("base64url"), tool: { id: tool.name, contractVersion: tool.contractVersion, contractHash: tool.contractHash },
      relay: client.relay, inputs: { uiType: "Canvas", name: "Qualification Named Node" },
      observation: { contractId: tool.operations["*"].observation.contractId, consentVersion: tool.operations["*"].observation.consentVersion,
        fields, revisionToken: "qualification-revision", digest: sha256(canonicalizeToBytes(fields)) } };
    const body = Buffer.from(canonicalizeToBytes(signProtectedRequest(client.keyId, request, client.keys.privateKey)));
    const deferred = Promise.withResolvers<{ status: number; body: Buffer }>();
    const networkStarted = performance.now();
    const req = httpRequest({ hostname: "127.0.0.1", port: this.port, path: "/ccp/v1/execute", method: "POST", agent: client.agent,
      headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json", "content-length": body.length } }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 768 * 1024) res.destroy(new Error("RESPONSE_BOUND")); else chunks.push(chunk); });
      res.once("error", deferred.reject);
      res.once("end", () => deferred.resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("REQUEST_TIMEOUT")));
    req.once("error", deferred.reject); req.end(body);
    let status = 0; let ipcCount = 0; let nameHash: string | undefined;
    try {
      const response = await deferred.promise; status = response.status;
      const networkMs = performance.now() - networkStarted;
      const decoded = JSON.parse(response.body.toString("utf8"));
      invariant(status === expectedStatus, typeof decoded.code === "string" ? decoded.code : "UNEXPECTED_HTTP_STATUS");
      invariant(expectedCode === undefined || decoded.code === expectedCode, "UNEXPECTED_DENIAL_CODE");
      if (status !== 200) {
        this.evidence.emit({ type: "sample", scenario, pass: true, deviceId: client.deviceId, status, code: decoded.code, requestCount: 1, actualCreatorIpc: 0, durationMs: performance.now() - started });
        return { latencyMs: performance.now() - started };
      }
      const verifyStarted = performance.now();
      const verified = verifyDecision({ request, signed: decoded, executionKeys: new Map([["qualification-execution", this.executionKeys.publicKey]]),
        replayWindow: client.replay, tool, operation: tool.operations["*"] });
      const verifyMs = performance.now() - verifyStarted;
      invariant(verified.decision.kind === "execute", "EXPECTED_EXECUTE_DECISION");
      const executeStarted = performance.now();
      const result = await executeEnvelope(verified.decision.envelope, {
        invoke: async (command) => {
          invariant(command.op === "scene.createNode", "UNEXPECTED_SIMULATED_PRIMITIVE");
          // Simulate the finite prefab lookup followed by node creation.
          ipcCount += command.args.prefab ? 2 : 1; nameHash = sha256(String(command.args.name));
          return { id: "simulated-created-node", type: "cc.Node" };
        },
        snapshot: async () => { ipcCount += 1; },
        recheckPreconditions: async (envelope) => {
          invariant(envelope.preconditions.every((precondition) => precondition.digest === request.observation!.digest
            && precondition.revisionToken === request.observation!.revisionToken), "SIMULATED_PRECONDITION_MISMATCH");
        }, readIpcCount: () => ipcCount,
      }, request, { publicConstants: tool.publicConstants as IJson, deadlineAtMs: verified.deadlineAtMs });
      invariant(result.ipcCount === ipcCount, "SIMULATED_IPC_ACCOUNTING_MISMATCH");
      const phases = this.store.db.prepare("SELECT phase_timings_json FROM ccp_audit WHERE correlation_id = ?").get(verified.decision.correlationId) as { phase_timings_json: string } | undefined;
      invariant(phases, "MISSING_GATEWAY_PHASE_EVIDENCE");
      const gatewayPhases = JSON.parse(phases.phase_timings_json) as Record<string, number>;
      const gatewayMs = ["verify", "authorize", "plan", "validate", "sign"].reduce((sum, phase) => sum + gatewayPhases[phase], 0);
      invariant(Number.isFinite(gatewayMs), "MISSING_GATEWAY_PHASE");
      const latencyMs = performance.now() - started;
      this.evidence.emit({ type: "sample", scenario, pass: true, deviceId: client.deviceId, instanceId: client.instanceId, requestId: request.requestId,
        build: client.relay.build, packageHash: client.relay.packageHash, status, gatewayOutcome: "signed-decision", creatorOutcome: "not-exercised",
        requestCount: 1, actualCreatorIpc: 0, simulatedIpc: ipcCount, requestBytes: body.length, responseBytes: response.body.length,
        resultHash: nameHash, durationMs: latencyMs, networkMs, verifyMs, simulatedExecuteMs: performance.now() - executeStarted, gatewayPhases });
      return { latencyMs, nameHash, gatewayMs };
    } catch (error) {
      this.evidence.emit({ type: "sample", scenario, pass: false, deviceId: client.deviceId, status, actualCreatorIpc: 0, simulatedIpc: ipcCount, errorCode: errorCode(error), durationMs: performance.now() - started });
      throw error;
    }
  }
}
