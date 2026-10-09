import { createHash, createPublicKey, type KeyLike } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { DeviceIdentity, DeviceIdentityStore } from "./device-identity";
import { GatewayClient } from "./gateway-client";
import { MutationJournal } from "./mutation-journal";
import { ReplayWindow } from "./replay-window";
import { ProtectedRelayStateMachine } from "./state-machine";
import { CcbError } from "./errors";
import { decodeBase64UrlBuffer, randomUUID } from "./node14-compat";
import { SignedRequestCache } from "./request-builder";
import { loadPublicToolManifest } from "./public-tool-loader";
import manifestJson from "./public-tool-manifest.json";
import { bootLog } from "./boot-log";
import { TelemetryBuffer } from "./telemetry-buffer";
import { QualificationTraceRecorder } from "./qualification-trace";
import { canonicalProjectPath, GatewayContext } from '../utcp/project-connection';

export function readGatewayFile(projectPath?: string, path = join(homedir(), '.cc-bridge', 'gateway.json')): Record<string, string> {
  if (!existsSync(path)) return {};
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Gateway configuration must be an object');
  let selected: Record<string, unknown> = raw as Record<string, unknown>;
  if ('projects' in selected) {
    if (!projectPath || !selected.projects || typeof selected.projects !== 'object' || Array.isArray(selected.projects)) throw new Error('project-scoped Gateway configuration requires the current project');
    const matches = Object.entries(selected.projects).filter(([path]) => {
      try { return canonicalProjectPath(path) === projectPath; } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENODEV', 'ENXIO'].includes(String(error.code))) return false;
        throw error;
      }
    });
    if (matches.length !== 1 || !matches[0][1] || typeof matches[0][1] !== 'object' || Array.isArray(matches[0][1])) throw new Error('no unambiguous Gateway assignment for the current project');
    selected = matches[0][1] as Record<string, unknown>;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(selected)) if (typeof value === 'string' && value) out[key] = value;
  if (projectPath && out.projectPath && canonicalProjectPath(out.projectPath) !== projectPath) throw new Error('Gateway assignment belongs to a different project');
  return out;
}

function verifyCanonicalContract(): void {
  try {
    loadPublicToolManifest(manifestJson);
  } catch (error) {
    throw new CcbError("CCB_CONTRACT_MISMATCH", "Installed canonical protected-tool manifest is invalid.", {
      cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    });
  }
}

interface InstalledPackageMetadata {
  packageSha256: string;
  targetPayloadSha256: string;
}

function installedPackageMetadata(): InstalledPackageMetadata {
  const explicitPackage = process.env.CCB_INSTALLED_PACKAGE_SHA256;
  const explicitTarget = process.env.CCB_INSTALLED_TARGET_PAYLOAD_SHA256;
  if (explicitPackage && /^[a-f0-9]{64}$/.test(explicitPackage)
    && explicitTarget && /^[a-f0-9]{64}$/.test(explicitTarget)) {
    return { packageSha256: explicitPackage, targetPayloadSha256: explicitTarget };
  }
  const roots = [resolve(__dirname, "..", ".."), resolve(__dirname, "..", "..", "..")];
  for (const root of roots) {
    const descriptorPath = join(root, ".ccb-staged.json");
    const manifestPath = join(root, ".ccb-package-manifest.json");
    if (!existsSync(descriptorPath) || !existsSync(manifestPath)) continue;
    const descriptorBytes = readFileSync(descriptorPath);
    const manifestBytes = readFileSync(manifestPath);
    let descriptor: unknown;
    try { descriptor = JSON.parse(descriptorBytes.toString("utf8")); } catch { throw new CcbError("CCB_BUILD_INCOMPATIBLE", "Installed package descriptor is corrupt."); }
    if (!descriptor || typeof descriptor !== "object" || !("packageSha256" in descriptor)
      || !("packageManifestSha256" in descriptor) || !("targetPayloadSha256" in descriptor)
      || typeof descriptor.packageSha256 !== "string" || typeof descriptor.packageManifestSha256 !== "string"
      || typeof descriptor.targetPayloadSha256 !== "string") {
      throw new CcbError("CCB_BUILD_INCOMPATIBLE", "Installed package descriptor does not bind package and target digests.");
    }
    const manifestDigest = createHash("sha256").update(manifestBytes).digest("hex");
    if (manifestDigest !== descriptor.packageManifestSha256 || !/^[a-f0-9]{64}$/.test(descriptor.packageSha256)
      || !/^[a-f0-9]{64}$/.test(descriptor.targetPayloadSha256)) {
      throw new CcbError("CCB_SIGNATURE_INVALID", "Installed package metadata does not match its verified descriptor.");
    }
    return { packageSha256: descriptor.packageSha256, targetPayloadSha256: descriptor.targetPayloadSha256 };
  }
  throw new CcbError("CCB_BUILD_INCOMPATIBLE", "No verified installed package descriptor is available.", { searchedFrom: dirname(__dirname) });
}

export class ProtectedRelayHost {
  readonly state = new ProtectedRelayStateMachine();
  readonly identityStore = new DeviceIdentityStore();
  readonly journal = new MutationJournal();
  readonly replayWindow = new ReplayWindow();
  readonly requestCache = new SignedRequestCache();
  readonly telemetry = new TelemetryBuffer();
  readonly qualificationTrace = QualificationTraceRecorder.fromEnv();
  relayInstanceId = randomUUID();
  readonly identity: DeviceIdentity | null;
  readonly packageHash: string | null;
  readonly targetPayloadHash: string | null;
  private readonly bootFailure: CcbError | null;
  client: GatewayClient | null = null;
  executionKeys = new Map<string, KeyLike>();
  projectId: string | null = null;
  gatewayContext: GatewayContext = { origin: null, projectId: null };
  private readonly localProjectPath?: string;

  constructor(projectPath?: string) {
    this.localProjectPath = projectPath ? canonicalProjectPath(projectPath) : undefined;
    let identity: DeviceIdentity | null = null;
    let packageHash: string | null = null;
    let targetPayloadHash: string | null = null;
    let bootFailure: CcbError | null = null;
    try {
      verifyCanonicalContract();
      identity = this.identityStore.loadOrCreate();
      const installed = installedPackageMetadata();
      packageHash = installed.packageSha256;
      targetPayloadHash = installed.targetPayloadSha256;
    } catch (error) {
      bootFailure = error instanceof CcbError
        ? error
        : new CcbError("CCB_DEVICE_DENIED", "Device identity is corrupt or cannot be durably written.", { cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) });
    }
    this.identity = identity;
    this.packageHash = packageHash;
    this.bootFailure = bootFailure;
    this.targetPayloadHash = targetPayloadHash;
    if (identity && packageHash && targetPayloadHash && this.qualificationTrace) {
      this.qualificationTrace.configureLive(this.identityStore.privateKey(identity), identity.deviceKeyId,
        { deviceId: identity.deviceId, publicKeyDer: identity.publicKeyDer, packageHash, targetPayloadHash });
    }
    this.state.finishBootLocked(bootFailure ? {
      code: bootFailure.body.code,
      error: bootFailure.body.error,
      details: bootFailure.body.details,
    } : {
      code: "CCB_GATEWAY_UNAVAILABLE",
      error: "Protected relay is locked until Gateway origin, project, approval, and execution keys are configured.",
    });
  }

  activateIfConfigured(): void {
    const file = readGatewayFile(this.localProjectPath);
    const origin = process.env.CCB_GATEWAY_ORIGIN || file.origin;
    const projectId = process.env.CCB_PROJECT_ID || file.projectId;
    const memberCredential = process.env.CCB_MEMBER_CREDENTIAL || file.memberCredential;
    const executionKey = process.env.CCB_EXECUTION_PUBLIC_KEY || file.executionPublicKey;
    const approvedDeviceId = process.env.CCB_APPROVED_DEVICE_ID || file.approvedDeviceId;
    const approvedDeviceKeyId = process.env.CCB_APPROVED_DEVICE_KEY_ID || file.approvedDeviceKeyId;
    const keyId = process.env.CCB_EXECUTION_KEY_ID || file.executionKeyId || "execution-dev-1";
    const parsedOrigin = origin ? new URL(origin) : null;
    if (parsedOrigin && (parsedOrigin.username || parsedOrigin.password || parsedOrigin.search || parsedOrigin.hash)) throw new Error('Gateway origin must not contain credentials, query, or fragment');
    this.gatewayContext = { origin: parsedOrigin?.origin || null, projectId: projectId || null,
      ...(file.containerId ? { containerId: file.containerId } : {}) };
    if (this.bootFailure || !this.identity || !this.packageHash) {
      const failure = this.bootFailure ?? new CcbError("CCB_BUILD_INCOMPATIBLE", "Relay identity or installed package digest is unavailable.");
      this.state.lock({ code: failure.body.code, error: failure.body.error, details: failure.body.details });
      bootLog("error", `Protected relay disconnected: ${failure.body.code} ${failure.body.error}`);
      return;
    }
    if (!origin || !projectId || !memberCredential || !executionKey || approvedDeviceId !== this.identity.deviceId || approvedDeviceKeyId !== this.identity.deviceKeyId) {
      const error = "Protected tools stay locked until this exact local identity is enrolled and approved.";
      this.state.lock({
        code: "CCB_DEVICE_DENIED",
        error,
        details: { deviceId: this.identity.deviceId, deviceKeyId: this.identity.deviceKeyId },
      });
      bootLog("error", `Protected relay disconnected: CCB_DEVICE_DENIED ${error}`);
      return;
    }
    try {
      this.client?.close();
      this.client = new GatewayClient({
        origin,
        memberCredential: () => memberCredential,
        allowInsecureLoopback: process.env.CCB_ALLOW_INSECURE_GATEWAY === "1" || file.allowInsecureGateway === "1",
        qualificationTrace: this.qualificationTrace ?? undefined,
      });
      this.executionKeys = new Map([[keyId, createPublicKey({ key: decodeBase64UrlBuffer(executionKey), format: "der", type: "spki" })]]);
      this.projectId = projectId;
      this.state.activate();
      bootLog("info", `Protected relay connected to Gateway (origin=${origin}, project=${projectId})`);
    } catch (error) {
      this.client = null;
      this.executionKeys.clear();
      this.projectId = null;
      const code = error instanceof CcbError ? error.body.code : "CCB_GATEWAY_UNAVAILABLE";
      const message = error instanceof CcbError ? error.body.error : "Protected relay failed to activate.";
      this.state.lock({ code, error: message });
      bootLog("error", `Protected relay disconnected: ${code} ${message}`);
    }
  }

  close(): void {
    const wasConnected = this.client !== null || this.state.state === "ACTIVE";
    this.client?.close();
    this.qualificationTrace?.close();
    this.client = null;
    this.executionKeys.clear();
    this.projectId = null;
    if (wasConnected) bootLog("info", "Protected relay disconnected from Gateway");
  }
}
