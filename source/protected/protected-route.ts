import { assertIJson, IJson } from "./canonical-json";
import { createCreatorAdapters } from "./creator-adapters";
import { CcpError } from "./errors";
import { dispatchProtectedTool, type ProtectedDispatchContext } from "./protected-dispatcher";
import type { ProtectedRelayHost } from "./relay-host";
import { GATEWAY_PROTECTED_TOOLS } from "./protected-tool-names";
import { getBuildInfo } from "../build-info";
import { loadPublicToolManifest, type PublicToolManifest } from "./public-tool-loader";
import manifestJson from "./public-tool-manifest.json";

let manifest: PublicToolManifest | undefined;

function canonicalManifest() {
  try {
    manifest ??= loadPublicToolManifest(manifestJson);
    return manifest;
  } catch (error) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Installed canonical protected-tool manifest is invalid.", {
      cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    });
  }
}

export function isProtectedCustomerTool(name: string): boolean {
  return GATEWAY_PROTECTED_TOOLS.has(name);
}

export async function dispatchProtectedCustomerTool(
  host: ProtectedRelayHost,
  name: string,
  inputs: unknown,
  dispatch: ProtectedDispatchContext = {},
): Promise<IJson> {
  if (!GATEWAY_PROTECTED_TOOLS.has(name)) {
    throw new CcpError("CCP_CONTRACT_MISMATCH", "Protected tool is absent from the canonical public contract.", { tool: name });
  }
  host.state.assertActive();
  if (!host.identity || !host.packageHash) throw new CcpError("CCP_DEVICE_DENIED", "Protected relay has no verified local identity or installed package digest.");
  if (!host.client || !host.projectId || host.executionKeys.size === 0) {
    throw new CcpError("CCP_GATEWAY_UNAVAILABLE", "Protected tools require a warm Gateway client, project, and execution public key.");
  }
  assertIJson(inputs);
  const build = getBuildInfo();
  const creatorVersion = Editor.App.version;
  if (typeof creatorVersion !== "string" || !creatorVersion) throw new CcpError("CCP_CREATOR_INCOMPATIBLE", "Creator runtime did not expose Editor.App.version.");
  let creatorIpcCount = 0;
  const creatorRequest = async (module: string, message: string, ...args: unknown[]) => {
    creatorIpcCount += 1;
    return Editor.Message.request(module as never, message as never, ...args as never[]);
  };
  const selection = {
    getSelected: (type: "node" | "asset") => [...Editor.Selection.getSelected(type)],
    getLastSelected: (type: "node" | "asset") => Editor.Selection.getLastSelected(type) || undefined,
  };
  const invoke = createCreatorAdapters(creatorRequest, {
    selection: {
      select: (type, values) => Editor.Selection.select(type, values),
      unselect: (type, values) => Editor.Selection.unselect(type, values),
      clear: (type) => Editor.Selection.clear(type),
      hover: (type, value) => Editor.Selection.hover(type, value),
      update: (type, values) => Editor.Selection.update(type, values),
      getSelected: selection.getSelected,
      getLastSelected: selection.getLastSelected,
    },
  });
  return dispatchProtectedTool({
    state: host.state,
    identity: host.identity,
    identityStore: host.identityStore,
    projectId: host.projectId,
    relayInstanceId: host.relayInstanceId,
    sequence: host.replayWindow,
    replayWindow: host.replayWindow,
    journal: host.journal,
    requestCache: host.requestCache,
    client: host.client,
    executionKeys: host.executionKeys,
    relay: {
      build: build.version,
      packageHash: host.packageHash,
      creatorVersion,
      os: `${process.platform}-${process.arch}`,
    },
    adapters: {
      invoke,
      snapshot: async () => { await creatorRequest("scene", "snapshot"); },
      recheckPreconditions: async () => {
        throw new CcpError("CCP_PRECONDITION_FAILED", "Effectful protected dispatch must install a live observation recheck.");
      },
      readIpcCount: () => creatorIpcCount,
    },
    observationRuntime: { request: creatorRequest, selection },
    telemetry: host.telemetry,
    qualificationTrace: host.qualificationTrace ?? undefined,
  }, canonicalManifest(), name, inputs, dispatch);
}
