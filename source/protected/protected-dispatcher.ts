import { KeyLike } from "crypto";
import { assertIJson, IJson } from "./canonical-json";
import { CcpError } from "./errors";
import { executeEnvelope, type PrimitiveAdapters, type PrimitiveExecution } from "./primitive-executor";
import { collectObservation, type ObservationRuntime, recheckObservation } from "./observation-collectors";
import { findPublicTool, findPublicToolOperation, type PublicToolManifest } from "./public-tool-loader";
import { buildProtectedRequest, canonicalToolInputDigest, SignedRequestCache } from "./request-builder";
import { routeExecutionResult, routeFiniteResult, type LocalExecutionResult } from "./result-router";
import { verifyDecision } from "./decision-verifier";
import type { GatewayClient } from "./gateway-client";
import type { MutationJournal, JournalOutcomeEvidence } from "./mutation-journal";
import type { ReplayWindow } from "./replay-window";
import type { DeviceIdentity } from "./device-identity";
import type { ProtectedRelayStateMachine } from "./state-machine";
import { DeviceIdentityStore } from "./device-identity";
import type { QualificationTraceRecorder } from "./qualification-trace";
import type { TelemetryBuffer } from "./telemetry-buffer";
import type { CompletionTelemetry } from "./protocol";

export interface ProtectedDispatchContext {
  idempotencyKey?: string;
  qualificationCallId?: string;
  onQualificationRequest?: (requestId: string) => void;
}

export interface DispatcherContext {
  state: ProtectedRelayStateMachine;
  identity: DeviceIdentity;
  identityStore: DeviceIdentityStore;
  projectId: string;
  relayInstanceId: string;
  sequence: ReplayWindow;
  replayWindow: ReplayWindow;
  journal: MutationJournal;
  requestCache: SignedRequestCache;
  client: GatewayClient;
  executionKeys: ReadonlyMap<string, KeyLike>;
  relay: { build: string; packageHash: string; creatorVersion: string; os: string };
  adapters: PrimitiveAdapters;
  observationRuntime: ObservationRuntime;
  qualificationTrace?: QualificationTraceRecorder;
  telemetry?: TelemetryBuffer;
}

function evidenceFromError(error: CcpError): JournalOutcomeEvidence {
  const details = error.body.details;
  const attempted = typeof details.attemptedCommandIds === "string" && details.attemptedCommandIds ? details.attemptedCommandIds.split(",") : [];
  const completed = typeof details.executedCommandIds === "string" && details.executedCommandIds ? details.executedCommandIds.split(",") : [];
  return {
    attemptedCommandIds: attempted,
    completedCommandIds: completed,
    failingCommandId: typeof details.failingCommandId === "string" && details.failingCommandId ? details.failingCommandId : undefined,
    causalCode: typeof details.causalCode === "string" && details.causalCode ? details.causalCode : error.body.code,
    cause: typeof details.cause === "string" ? details.cause : error.body.error,
    snapshot: {
      attempted: details.snapshotAttempted === true,
      completed: details.snapshotCompleted === true,
      ...(typeof details.snapshotError === "string" && details.snapshotError ? { error: details.snapshotError } : {}),
    },
  };
}

function localResult(execution: PrimitiveExecution): LocalExecutionResult {
  const summary: IJson = {
    attemptedCommandIds: execution.attemptedCommandIds,
    executedCommandIds: execution.executedCommandIds,
    snapshotTaken: execution.snapshotTaken,
    snapshotOutcome: {
      attempted: execution.snapshotOutcome.attempted,
      completed: execution.snapshotOutcome.completed,
      ...(execution.snapshotOutcome.error ? { error: execution.snapshotOutcome.error } : {}),
    },
    ipcCount: execution.ipcCount,
  };
  return { commandResults: execution.commandResults, summary };
}
function completionOutcome(value: string): CompletionTelemetry["outcome"] | undefined {
  if (value === "completed") return "completed";
  if (value === "outcome-unknown") return "outcome-unknown";
  if (value === "failed") return "failed";
  return undefined;
}

export async function dispatchProtectedTool(
  ctx: DispatcherContext,
  manifest: PublicToolManifest,
  toolName: string,
  inputs: IJson,
  dispatch: ProtectedDispatchContext = {},
): Promise<IJson> {
  const startedAtMs = Date.now();
  let requestId: string | undefined;
  const finish = ctx.state.beginWork();
  let traceId: string | undefined;
  let ipcBeforeGateway: number | null = null;
  let traceKind: "execute" | "result" | "denied" | "failed" = "failed";
  let traceOutcome: "completed" | "failed" | "denied" | "outcome-unknown" = "failed";
  let traceResult: unknown = null;
  let traceError: string | undefined;
  const completed = (result: IJson): IJson => {
    traceOutcome = "completed";
    traceResult = result;
    return result;
  };
  try {
    const tool = findPublicTool(manifest, toolName);
    const operation = findPublicToolOperation(tool, inputs);
    if (operation.effect !== "none" && !dispatch.idempotencyKey) {
      throw new CcpError("CCP_AUTH_REQUIRED", "Effectful protected calls require an authenticated stable idempotency key.");
    }
    const toolBinding = { id: tool.name, contractVersion: tool.contractVersion, contractHash: tool.contractHash };
    const inputDigest = canonicalToolInputDigest(toolBinding, inputs);
    assertIJson(tool.publicConstants);
    let telemetryDelivered = false;
    let pendingTelemetry: CompletionTelemetry[] | undefined;
    const publicConstants: IJson = tool.publicConstants as IJson;
    const build = async () => {
      const observation = operation.observation.contractId === "none-v1"
        ? undefined
        : await collectObservation(operation.observation, inputs, ctx.observationRuntime);
      const telemetry = dispatch.idempotencyKey ? undefined : ctx.telemetry?.take();
      pendingTelemetry = telemetry;
      const options = {
        deviceKeyId: ctx.identity.deviceKeyId,
        deviceId: ctx.identity.deviceId,
        projectId: ctx.projectId,
        relayInstanceId: ctx.relayInstanceId,
        sequence: ctx.sequence.nextSequence(),
        tool: toolBinding,
        relay: ctx.relay,
        inputs,
        ...(observation ? { observation } : {}),
        idempotencyKey: dispatch.idempotencyKey,
        privateKey: ctx.identityStore.privateKey(ctx.identity),
      };
      try {
        return buildProtectedRequest({ ...options, ...(telemetry ? { priorTelemetry: telemetry } : {}) });
      } catch (error) {
        ctx.telemetry?.restore(telemetry);
        pendingTelemetry = undefined;
        if (telemetry && error instanceof RangeError && error.message === "request payload exceeds limit") return buildProtectedRequest(options);
        throw error;
      }
    };
    const built = dispatch.idempotencyKey
      ? await ctx.requestCache.getOrBuild(dispatch.idempotencyKey, inputDigest, build)
      : await build();
    requestId = built.request.requestId;
    if (ctx.qualificationTrace) {
      ctx.qualificationTrace.begin(built.request, dispatch.qualificationCallId);
      dispatch.onQualificationRequest?.(built.request.requestId);
      traceId = built.request.requestId;
      ipcBeforeGateway = ctx.adapters.readIpcCount?.() ?? null;
    }
    let signed;
    try {
      signed = await ctx.client.execute(built.signed);
      telemetryDelivered = true;
      pendingTelemetry = undefined;
    } catch (error) {
      if (!telemetryDelivered) ctx.telemetry?.restore(pendingTelemetry);
      const ccp = error instanceof CcpError ? error : new CcpError("CCP_GATEWAY_UNAVAILABLE", "Gateway request failed.");
      traceKind = "denied";
      traceOutcome = "denied";
      traceError = ccp.body.code;
      throw error;
    }
    const verified = verifyDecision({
      request: built.request,
      signed,
      executionKeys: ctx.executionKeys,
      replayWindow: ctx.replayWindow,
      tool,
      operation,
    });
    traceKind = verified.decision.kind;
    ctx.qualificationTrace?.phase(built.request.requestId, "decision-verified");
    if (verified.decision.kind === "result") {
      return completed(routeFiniteResult(verified.decision, built.request));
    }
    const envelope = verified.decision.envelope;
    const adapters: PrimitiveAdapters = {
      ...ctx.adapters,
      recheckPreconditions: async (signedEnvelope) => {
        if (operation.observation.contractId === "none-v1" || !built.request.observation) {
          throw new CcpError("CCP_PRECONDITION_FAILED", "Effect envelope has no canonical observation to recheck.");
        }
        await recheckObservation(operation.observation, inputs, built.request.observation, ctx.observationRuntime);
        for (const precondition of signedEnvelope.preconditions) {
          if (precondition.revisionToken !== built.request.observation.revisionToken || precondition.digest !== built.request.observation.digest) {
            throw new CcpError("CCP_PRECONDITION_FAILED", "Signed precondition does not match the authorized observation.");
          }
        }
      },
    };
    if (envelope.effect === "none") {
      ctx.qualificationTrace?.phase(built.request.requestId, "execution-start");
      const execution = await executeEnvelope(envelope, adapters, built.request, {
        publicConstants,
        deadlineAtMs: verified.deadlineAtMs,
      });
      ctx.qualificationTrace?.executionCommands(built.request.requestId, execution.executedCommandIds.length);
      ctx.qualificationTrace?.phase(built.request.requestId, "execution-finish");
      return completed(routeExecutionResult(envelope, localResult(execution)));
    }

    const admission = ctx.journal.prepare(verified.decisionDigest, built.request.requestId, built.request.idempotencyKey);
    if (admission.action === "return-completed") {
      traceKind = "result";
      return completed(admission.result);
    }
    let started = false;
    try {
      ctx.qualificationTrace?.phase(built.request.requestId, "execution-start");
      const execution = await executeEnvelope(envelope, adapters, built.request, {
        publicConstants,
        deadlineAtMs: verified.deadlineAtMs,
        onEffectAttempt: (commandId) => {
          ctx.journal.markStarted(verified.decisionDigest, commandId);
          started = true;
        },
      });
      ctx.qualificationTrace?.executionCommands(built.request.requestId, execution.executedCommandIds.length);
      ctx.qualificationTrace?.phase(built.request.requestId, "execution-finish");
      const result = routeExecutionResult(envelope, localResult(execution));
      ctx.journal.markCompleted(verified.decisionDigest, result, {
        attemptedCommandIds: execution.attemptedCommandIds,
        completedCommandIds: execution.executedCommandIds,
        snapshot: execution.snapshotOutcome,
      });
      return completed(result);
    } catch (error) {
      if (started) {
        const ccp = error instanceof CcpError ? error : new CcpError("CCP_OUTCOME_UNKNOWN", "Creator effect may have begun.");
        const outcome = ccp.body.code === "CCP_OUTCOME_UNKNOWN"
          ? ccp
          : new CcpError("CCP_OUTCOME_UNKNOWN", ccp.body.error, ccp.body.details);
        try {
          ctx.journal.markOutcomeUnknown(verified.decisionDigest, evidenceFromError(outcome));
        } catch (journalError) {
          throw new CcpError("CCP_OUTCOME_UNKNOWN", outcome.body.error, {
            ...outcome.body.details,
            journalError: journalError instanceof Error ? journalError.message.slice(0, 512) : String(journalError).slice(0, 512),
          });
        }
        throw outcome;
      }
      throw error;
    }
  } catch (error) {
    traceError = error instanceof CcpError ? error.body.code : "CCP_INTERNAL";
    if (traceError === "CCP_OUTCOME_UNKNOWN") traceOutcome = "outcome-unknown";
    if (error instanceof CcpError) throw error;
    throw new CcpError("CCP_INTERNAL", "Protected dispatch failed before a local result was produced.", {
      cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    });
  } finally {
    if (traceId) ctx.qualificationTrace?.finish(traceId, traceOutcome, traceKind,
      ctx.adapters.readIpcCount?.() ?? null, ipcBeforeGateway, traceResult, traceError);
    if (requestId) {
      const telemetryOutcome = completionOutcome(traceOutcome);
      if (telemetryOutcome) ctx.telemetry?.push({ requestId, outcome: telemetryOutcome, durationMs: Math.min(300_000, Math.max(0, Date.now() - startedAtMs)), ...(traceError ? { errorCode: traceError } : {}) });
    }
    finish();
  }
}
