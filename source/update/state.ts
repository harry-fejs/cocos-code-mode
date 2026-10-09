import { homedir } from "os"
import { join } from "path"
import { z } from "zod";
import { CcpError } from "../protected/errors";
import { readPrivateJson, writePrivateJsonAtomic } from "../protected/durable-file";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const StateSchema = z.object({
  schemaVersion: z.literal(1),
  highestRootVersion: z.number().int().nonnegative(),
  highestTargetSequence: z.number().int().nonnegative(),
  highestPolicySequence: z.number().int().nonnegative(),
  rootPayloadSha256: DigestSchema.optional(),
  targetPayloadSha256: DigestSchema.optional(),
  policyPayloadSha256: DigestSchema.optional(),
  activeTargetPayloadSha256: DigestSchema.optional(),
  stagedTargetPayloadSha256: DigestSchema.optional(),
  stagedDescriptorSha256: DigestSchema.optional(),
  rollbackTargetPayloadSha256: DigestSchema.optional(),
  channel: z.string().min(1).max(64).optional(),
  ring: z.enum(["1", "3", "10"]).optional(),
  activationState: z.enum([
    "idle",
    "staged",
    "activation-launching",
    "activating",
    "pending-health",
    "retiring-backup",
    "active",
    "rollback-required",
  ]).default("idle"),
}).strict();

export type UpdateState = z.infer<typeof StateSchema>;
const EMPTY_STATE: UpdateState = {
  schemaVersion: 1,
  highestRootVersion: 0,
  highestTargetSequence: 0,
  highestPolicySequence: 0,
  activationState: "idle",
};

function sameSequenceDigest(currentSequence: number, nextSequence: number, currentDigest: string | undefined, nextDigest: string | undefined, label: string): void {
  if (nextSequence < currentSequence) throw new CcpError("CCP_REPLAY", `${label} sequence rolled back.`);
  if (nextSequence === currentSequence && currentSequence !== 0 && currentDigest !== nextDigest) {
    throw new CcpError("CCP_REPLAY", `${label} sequence was reused with different signed bytes.`);
  }
}

export class UpdateStateStore {
  constructor(readonly path = join(homedir(), ".ccp", "update-state-v1.json")) {}

  load(): UpdateState {
    const stored = readPrivateJson(this.path, 16 * 1024);
    return stored === undefined ? { ...EMPTY_STATE } : StateSchema.parse(stored);
  }

  persistIfMonotonic(input: UpdateState): UpdateState {
    const next = StateSchema.parse(input);
    const current = this.load();
    sameSequenceDigest(current.highestRootVersion, next.highestRootVersion, current.rootPayloadSha256, next.rootPayloadSha256, "Root");
    sameSequenceDigest(current.highestTargetSequence, next.highestTargetSequence, current.targetPayloadSha256, next.targetPayloadSha256, "Target");
    sameSequenceDigest(current.highestPolicySequence, next.highestPolicySequence, current.policyPayloadSha256, next.policyPayloadSha256, "Policy");
    writePrivateJsonAtomic(this.path, next);
    return next;
  }

  initializeInstalledTarget(targetPayloadSha256: string): UpdateState {
    const digest = DigestSchema.parse(targetPayloadSha256);
    const state = this.load();
    if (state.activeTargetPayloadSha256) return state;
    if (state.activationState !== "idle") {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Cannot initialize the installed target after update activation has begun.");
    }
    return this.persistIfMonotonic({ ...state, activeTargetPayloadSha256: digest, activationState: "active" });
  }
  beginActivationLaunch(): UpdateState {
    const state = this.load();
    if (state.activationState !== "staged" || !state.stagedTargetPayloadSha256 || !state.stagedDescriptorSha256) {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "No verified staged release is ready for activation.");
    }
    return this.persistIfMonotonic({ ...state, activationState: "activation-launching" });
  }

  markActivationSpawned(): UpdateState {
    const state = this.load();
    if (state.activationState !== "activation-launching") {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Activation helper was not in the launching state.");
    }
    return this.persistIfMonotonic({ ...state, activationState: "activating" });
  }

  markActivationLaunchFailed(): UpdateState {
    const state = this.load();
    if (state.activationState !== "activation-launching") return state;
    return this.persistIfMonotonic({ ...state, activationState: "staged" });
  }

  recoverActivation(backupPresent: boolean): UpdateState {
    const state = this.load();
    if (state.activationState === "retiring-backup") {
      if (backupPresent) return state;
      return this.markBackupRetired(false);
    }
    if (state.activationState === "pending-health" || state.activationState === "rollback-required") {
      if (!backupPresent) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "Pending-health rollback backup is missing.");
      return state;
    }
    if (state.activationState === "activation-launching" || state.activationState === "activating") {
      return this.persistIfMonotonic({ ...state, activationState: backupPresent ? "pending-health" : "staged" });
    }
    return state;
  }

  markHealthPassed(): UpdateState {
    const state = this.load();
    if (state.activationState !== "pending-health" || !state.stagedTargetPayloadSha256) {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "No staged release is pending health.");
    }
    return this.persistIfMonotonic({ ...state, activationState: "retiring-backup" });
  }

  markBackupRetired(backupPresent: boolean): UpdateState {
    const state = this.load();
    if (state.activationState !== "retiring-backup") {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "The prior package is not awaiting retirement.");
    }
    if (backupPresent) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "The prior package backup still exists.");
    return this.persistIfMonotonic({
      ...state,
      activeTargetPayloadSha256: state.stagedTargetPayloadSha256,
      stagedTargetPayloadSha256: undefined,
      stagedDescriptorSha256: undefined,
      rollbackTargetPayloadSha256: undefined,
      activationState: "active",
    });
  }

  markRollbackRequired(): UpdateState {
    const state = this.load();
    if (state.activationState !== "pending-health") {
      throw new CcpError("CCP_BUILD_INCOMPATIBLE", "No activated release is pending health.");
    }
    if (!state.rollbackTargetPayloadSha256) throw new CcpError("CCP_BUILD_INCOMPATIBLE", "No signed-policy rollback target is available.");
    return this.persistIfMonotonic({ ...state, activationState: "rollback-required" });
  }
}
