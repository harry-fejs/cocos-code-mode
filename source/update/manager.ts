import { createHash } from "crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { CcpError } from "../protected/errors";
import { verifyStagedDirectory } from "../protected/staged-update";
import { decodeBase64Url } from "../protected/protocol";
import { fetchReleaseJson, assertReleaseOrigin, downloadReleaseArtifact } from "./client";
import { SignedMetadataSchema } from "./metadata";
import type { SignedMetadata } from "./metadata";
import { TrustedRootStore } from "./root-store";
import { stageVerifiedReleaseSet } from "./stager";
import { acceptRelease, acceptRootRotation } from "./trust";
import { UpdateStateStore } from "./state";
import type { AcceptedRelease, UpdateCompatibility } from "./trust";

const METADATA_LIMIT = 256 * 1024;
const SIDECAR_LIMIT = 16 * 1024 * 1024;

export interface UpdateManagerOptions {
  origin: string;
  compatibility: UpdateCompatibility;
  rootStore?: TrustedRootStore;
  stateStore?: UpdateStateStore;
  stagingRoot?: string;
}

export interface StagedUpdate {
  accepted: AcceptedRelease;
  stagedDirectory: string;
  descriptorSha256: string;
}

export class UpdateManager {
  private readonly origin: URL;
  private readonly rootStore: TrustedRootStore;
  private readonly stateStore: UpdateStateStore;
  private readonly stagingRoot: string;
  private checking: Promise<StagedUpdate> | null = null;

  constructor(private readonly options: UpdateManagerOptions) {
    this.origin = assertReleaseOrigin(options.origin);
    this.rootStore = options.rootStore ?? new TrustedRootStore();
    this.stateStore = options.stateStore ?? new UpdateStateStore();
    this.stagingRoot = options.stagingRoot ?? join(homedir(), ".ccp", "updates");
  }

  checkAndStage(signal?: AbortSignal): Promise<StagedUpdate> {
    if (!this.checking) this.checking = this.run(signal).finally(() => { this.checking = null; });
    return this.checking;
  }
  initializeInstalledTarget(targetPayloadSha256: string): void {
    this.stateStore.initializeInstalledTarget(targetPayloadSha256);
  }

  shouldInitializeInstalledTarget(): boolean {
    const state = this.stateStore.load();
    return state.activationState === "idle" || state.activationState === "active" || Boolean(state.activeTargetPayloadSha256);
  }

  beginActivationLaunch(): void {
    this.stateStore.beginActivationLaunch();
  }

  markActivationSpawned(): void {
    this.stateStore.markActivationSpawned();
  }

  markActivationLaunchFailed(): void {
    this.stateStore.markActivationLaunchFailed();
  }

  recoverActivation(backupPresent: boolean): void {
    this.stateStore.recoverActivation(backupPresent);
  }

  markHealthPassed(): void {
    this.stateStore.markHealthPassed();
  }

  markBackupRetired(backupPresent: boolean): void {
    this.stateStore.markBackupRetired(backupPresent);
  }

  markRollbackRequired(): void {
    this.stateStore.markRollbackRequired();
  }

  private async metadata(name: "root" | "target" | "policy", signal?: AbortSignal): Promise<SignedMetadata> {
    const input = await fetchReleaseJson(this.origin, new URL(`metadata/${name}.json`, this.origin).href, METADATA_LIMIT, signal);
    try { return SignedMetadataSchema.parse(input); }
    catch (error) {
      const detail = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 160) : "schema parse failed";
      throw new CcpError("CCP_CANONICAL_INVALID", `Release ${name} wrapper is invalid.`, { detail });
    }
  }

  private async run(signal?: AbortSignal): Promise<StagedUpdate> {
    let trusted = this.rootStore.load();
    const rootWrapper = await this.metadata("root", signal);
    const rootPayloadSha256 = createHash("sha256").update(decodeBase64Url(rootWrapper.payload, METADATA_LIMIT)).digest("hex");
    if (rootPayloadSha256 !== trusted.payloadSha256) {
      const root = acceptRootRotation(trusted.root, rootWrapper);
      this.rootStore.persist(root, rootPayloadSha256);
      trusted = { root, payloadSha256: rootPayloadSha256 };
    }
    const current = this.stateStore.load();
    this.stateStore.persistIfMonotonic({
      ...current,
      highestRootVersion: trusted.root.rootVersion,
      rootPayloadSha256: trusted.payloadSha256,
    });
    const [targetWrapper, policyWrapper] = await Promise.all([this.metadata("target", signal), this.metadata("policy", signal)]);
    const accepted = acceptRelease(trusted.root, targetWrapper, policyWrapper, this.options.compatibility, this.stateStore);
    const setDirectory = join(this.stagingRoot, accepted.targetPayloadSha256);
    const zipPath = join(setDirectory, "release.zip");
    const manifestPath = join(setDirectory, "package-manifest.json");
    const sbomPath = join(setDirectory, "sbom.cdx.json");
    const provenancePath = join(setDirectory, "provenance.intoto.json");
    const packageUrl = accepted.target.package.url;
    const sidecar = (name: string) => new URL(name, packageUrl).href;
    const extractionRoot = join(setDirectory, "extracted");
    const stagedDirectory = join(extractionRoot, "ccp3x");
    if (
      current.activationState === "staged"
      && current.stagedTargetPayloadSha256 === accepted.targetPayloadSha256
      && current.stagedDescriptorSha256
      && existsSync(stagedDirectory)
    ) {
      verifyStagedDirectory(stagedDirectory, current.stagedDescriptorSha256);
      return { accepted, stagedDirectory, descriptorSha256: current.stagedDescriptorSha256 };
    }
    rmSync(setDirectory, { recursive: true, force: true });
    mkdirSync(setDirectory, { recursive: true, mode: 0o700 });
    const writeMetadata = (name: string, wrapper: SignedMetadata): string => {
      const bytes = Buffer.from(`${JSON.stringify(wrapper)}\n`, "utf8");
      writeFileSync(join(setDirectory, `${name}.signed.json`), bytes, { flag: "wx", mode: 0o600 });
      return createHash("sha256").update(bytes).digest("hex");
    };
    const rootMetadataSha256 = writeMetadata("root", rootWrapper);
    const targetMetadataSha256 = writeMetadata("target", targetWrapper);
    const policyMetadataSha256 = writeMetadata("policy", policyWrapper);

    await downloadReleaseArtifact(this.origin, packageUrl, zipPath, accepted.target.package.size, accepted.target.package.sha256, signal);
    await downloadReleaseArtifact(this.origin, sidecar("package-manifest.json"), manifestPath, { maxBytes: SIDECAR_LIMIT }, accepted.target.package.packageManifestSha256, signal);
    await downloadReleaseArtifact(this.origin, sidecar("sbom.cdx.json"), sbomPath, { maxBytes: SIDECAR_LIMIT }, accepted.target.package.sbomSha256, signal);
    await downloadReleaseArtifact(this.origin, sidecar("provenance.intoto.json"), provenancePath, { maxBytes: SIDECAR_LIMIT }, accepted.target.package.provenanceSha256, signal);

    const policyPayloadSha256 = accepted.state.policyPayloadSha256;
    if (!policyPayloadSha256) throw new CcpError("CCP_INTERNAL", "Accepted policy digest was not persisted.");
    const staged = stageVerifiedReleaseSet(zipPath, manifestPath, sbomPath, provenancePath, extractionRoot, {
      packageSha256: accepted.target.package.sha256,
      packageBytes: accepted.target.package.size,
      packageManifestSha256: accepted.target.package.packageManifestSha256,
      sbomSha256: accepted.target.package.sbomSha256,
      provenanceSha256: accepted.target.package.provenanceSha256,
      targetPayloadSha256: accepted.targetPayloadSha256,
      policyPayloadSha256,
      rootMetadataSha256,
      targetMetadataSha256,
      policyMetadataSha256,
    });
    this.stateStore.persistIfMonotonic({
      ...this.stateStore.load(),
      stagedTargetPayloadSha256: accepted.targetPayloadSha256,
      activationState: "staged",
      stagedDescriptorSha256: staged.descriptorSha256,
    });
    return { accepted, stagedDirectory: staged.directory, descriptorSha256: staged.descriptorSha256 };
  }
}
