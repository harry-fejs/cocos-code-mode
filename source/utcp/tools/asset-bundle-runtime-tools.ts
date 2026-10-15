import { JsonSchema } from '@utcp/sdk';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { BUNDLE_RESOURCE_TYPES, BundleResourceType, resolveBundleArtifact, serveBundleArtifact } from '../utils/asset-bundle-artifact';
import { createBundleOperationSource } from '../utils/game-view-bundle';
import { executeGameViewOperation } from '../utils/game-view-transport';
import { RuntimeSessionTools } from './runtime-session-tools';
import { createHash } from 'crypto';

export interface AssetBundleRuntimeValidateArgs {
    sessionId: string; bundlePath: string; bundleName: string;
    resource?: { path: string; type: BundleResourceType; expectedUuid?: string }; timeoutMs?: number; expectedRevision?: string;
}
const resourceSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: [...BUNDLE_RESOURCE_TYPES] }, uuid: { type: 'string' }, loaded: { type: 'boolean', enum: [true] } },
    required: ['path', 'type', 'uuid', 'loaded'],
};

function bundleArtifactIdentity(project: string, artifact: ReturnType<typeof resolveBundleArtifact>) {
    const files = [{ name: artifact.configFile, bytes: artifact.config.length, sha256: createHash('sha256').update(artifact.config).digest('hex') }, { name: artifact.indexFile, bytes: artifact.index.length, sha256: createHash('sha256').update(artifact.index).digest('hex') }];
    const revision = createHash('sha256').update(JSON.stringify([project, artifact.root, artifact.name, artifact.version, files])).digest('hex');
    return { files, revision };
}

export class AssetBundleRuntimeTools {
    @utcpTool('assetBundleArtifactInspect', 'Read-only preflight of an explicit project-local built data bundle using the runtime resolver. Hashes config/index and reports bounded resource paths; does not serve, load, execute scripts or infer resource-file/runtime validity.', {
        type: 'object', additionalProperties: false, properties: { bundlePath: { type: 'string', minLength: 1, maxLength: 512 }, bundleName: { type: 'string', minLength: 1, maxLength: 128 }, maxResources: { type: 'integer', minimum: 1, maximum: 128, default: 32 }, resourceOffset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 }, expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['bundlePath', 'bundleName'],
    }, { type: 'object', properties: { bundleName: { type: 'string' }, version: { type: 'string' }, files: { type: 'array' }, revision: { type: 'string' }, resources: { type: 'array' }, resourceCount: { type: 'integer' }, resourceOffset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, truncated: { type: 'boolean' }, writes: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false }, verificationScope: { type: 'string' } }, required: ['bundleName', 'version', 'files', 'revision', 'resources', 'resourceCount', 'resourceOffset', 'nextOffset', 'truncated', 'writes', 'runtimeVerified', 'verificationScope'] }, 'POST', ['asset', 'bundle', 'artifact', 'inspect', 'read-only'])
    async assetBundleArtifactInspect(args: { bundlePath: string; bundleName: string; maxResources?: number; resourceOffset?: number; expectedRevision?: string }) {
        if (!args || Object.keys(args).some(key => !['bundlePath', 'bundleName', 'maxResources', 'resourceOffset', 'expectedRevision'].includes(key))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide only bundle identity, resource page bounds and optional expectedRevision.' });
        const limit = args.maxResources ?? 32;
        if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxResources must be1..128.' });
        const resourceOffset = args.resourceOffset ?? 0;
        if (!Number.isInteger(resourceOffset) || resourceOffset < 0 || resourceOffset > 10000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'resourceOffset must be0..10000.' });
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision must be a lowercase SHA-256 revision.' });
        const project = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
        if (!project) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'An active Creator project is required.' });
        const artifact = resolveBundleArtifact(project, args.bundlePath, args.bundleName);
        const { files, revision } = bundleArtifactIdentity(project, artifact);
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) throw new ToolError({ code: 'BUNDLE_ARTIFACT_CHANGED', status: 409, message: 'Bundle identity/config/index revision changed; restart resource paging.' });
        const config = JSON.parse(artifact.config.toString('utf8')) as { paths: Record<string, unknown[]>; types?: string[]; uuids: string[]; debug?: boolean };
        const entries = Object.entries(config.paths);
        if (resourceOffset > entries.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'resourceOffset exceeds current resource count.' });
        const resourceType = (entry: unknown[]) => typeof entry[1] === 'string' ? entry[1] : config.types?.[entry[1] as number] ?? null;
        const addressCounts = new Map<string, number>();
        for (const [, entry] of entries) { const address = JSON.stringify([entry[0], resourceType(entry)]); addressCounts.set(address, (addressCounts.get(address) ?? 0) + 1); }
        const resources = entries.slice(resourceOffset, resourceOffset + limit).map(([index, entry]) => {
            if (typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 256 || /[\u0000-\u001f\u007f]/.test(entry[0])) throw new ToolError({ code: 'INVALID_BUNDLE_RESOURCE', status: 422, message: 'Bundle resource path metadata is malformed or exceeds bounds.' });
            const type = resourceType(entry);
            return { index, path: entry[0], type, emittedUuid: config.debug === true ? index : config.uuids[Number(index)], uniqueAddress: addressCounts.get(JSON.stringify([entry[0], type])) === 1 };
        });
        const nextOffset = resourceOffset + resources.length < entries.length ? resourceOffset + resources.length : null;
        return { bundleName: artifact.name, version: artifact.version, files, revision, resources, resourceCount: entries.length, resourceOffset, nextOffset, truncated: nextOffset !== null, writes: false as const, runtimeVerified: false as const,
            verificationScope: 'Contained standalone data-only config/index preflight and target-bound revision of read bytes. Resource payload bytes, atomic config/index snapshot, transient ABA changes, runtime loading and cleanup are not verified.' };
    }

    @utcpTool('assetBundleRuntimeValidate', 'Load one explicit project-local built data bundle in the attached Game View, verify exact cc.assetManager identity and optional typed resource, then releaseAll/removeBundle and verify absence. Preloaded/shared assets are refused. Serves only the approved build folder on temporary loopback; no project scripts or external URLs.', {
        type: 'object', additionalProperties: false,
        properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 64 },
            bundlePath: { type: 'string', minLength: 1, maxLength: 512, description: 'Exact project-relative build/... bundle directory containing emitted config[.version].json and index[.version].js. This explicit target authorizes only its bounded temporary loopback serving.' },
            bundleName: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
            resource: { type: 'object', additionalProperties: false, properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: [...BUNDLE_RESOURCE_TYPES] }, expectedUuid: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['path', 'type'] },
            timeoutMs: { type: 'integer', minimum: 100, maximum: 5000 },
            expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Optional revision from assetBundleArtifactInspect; mismatches refuse before serving or runtime dispatch. Does not freeze resource payload files.' },
        }, required: ['sessionId', 'bundlePath', 'bundleName'],
    }, {
        type: 'object', additionalProperties: false,
        properties: {
            success: { type: 'boolean', enum: [true] }, sessionId: { type: 'string' }, targetId: { type: 'string' }, bundlePath: { type: 'string' }, bundleName: { type: 'string' },
            artifactRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            loaded: { type: 'boolean', enum: [true] }, identityVerified: { type: 'boolean', enum: [true] },
            resource: { anyOf: [resourceSchema, { type: 'null' }] },
            released: { type: 'boolean', enum: [true] }, removed: { type: 'boolean', enum: [true] }, absent: { type: 'boolean', enum: [true] }, unrelatedPreserved: { type: 'boolean', enum: [true] },
        }, required: ['success', 'sessionId', 'targetId', 'bundlePath', 'bundleName', 'artifactRevision', 'loaded', 'identityVerified', 'resource', 'released', 'removed', 'absent', 'unrelatedPreserved'],
    }, 'POST', ['asset', 'bundle', 'runtime', 'load', 'release', 'validate'])
    async assetBundleRuntimeValidate(args: AssetBundleRuntimeValidateArgs): Promise<Record<string, unknown>> {
        const invalid = (message: string): never => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); };
        if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64) invalid('sessionId must contain 1..64 characters.');
        const timeoutMs = args.timeoutMs ?? 3000;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) invalid('timeoutMs must be an integer from 100 to 5000.');
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision))) invalid('expectedRevision must be a lowercase SHA-256 revision.');
        if (args.resource !== undefined && (!args.resource || typeof args.resource.path !== 'string' || args.resource.path.length > 256 || !args.resource.path || args.resource.path.includes('\\') || args.resource.path.includes(':') || args.resource.path.includes('\0') || args.resource.path.split('/').some(part => !part || part === '.' || part === '..') || !BUNDLE_RESOURCE_TYPES.includes(args.resource.type))) invalid('resource must identify one relative forward-slash path and an allowlisted data asset type.');
        if (args.resource?.expectedUuid !== undefined && (typeof args.resource.expectedUuid !== 'string' || !args.resource.expectedUuid || args.resource.expectedUuid.length > 256 || /[\s\u0000-\u001f\u007f]/.test(args.resource.expectedUuid))) invalid('resource.expectedUuid must be a bounded exact runtime UUID token.');
        const project = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
        if (!project) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'An active Creator project is required.' });
        const artifact = resolveBundleArtifact(project, args.bundlePath, args.bundleName);
        const artifactRevision = bundleArtifactIdentity(project, artifact).revision;
        if (args.expectedRevision !== undefined && args.expectedRevision !== artifactRevision) throw new ToolError({ code: 'BUNDLE_ARTIFACT_CHANGED', status: 409, message: 'Bundle config/index revision differs from the inspected precondition; no serving or runtime dispatch.' });
        if (args.resource) {
            const config = JSON.parse(artifact.config.toString('utf8')) as { paths: Record<string, unknown[]>; types?: string[] };
            let matches = 0;
            for (const entry of Object.values(config.paths)) {
                const type = typeof entry[1] === 'string' ? entry[1] : config.types?.[entry[1] as number];
                if (entry[0] === args.resource.path && type === `cc.${args.resource.type}`) matches++;
            }
            if (matches === 0) throw new ToolError({ code: 'BUNDLE_RESOURCE_NOT_FOUND', status: 404, message: 'Requested exact resource path/type is absent from captured bundle metadata; no serving or runtime dispatch.' });
            if (matches > 1) throw new ToolError({ code: 'BUNDLE_RESOURCE_AMBIGUOUS', status: 409, message: 'Requested resource path/type resolves to multiple emitted entries; no serving or runtime dispatch.' });
        }
        const runtime = new RuntimeSessionTools();
        const inspected = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs });
        const session = inspected.session;
        if (session && 'status' in session && session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: 'The attached runtime session is stopped.' });
        if (!inspected.success || !inspected.ready || !session || !('status' in session) || !('targetId' in session) || session.status !== 'attached' || session.targetKind !== 'game-view' || session.sessionId !== args.sessionId) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'The exact attached Game View session must be ready.' });
        const served = await serveBundleArtifact(artifact);
        try {
            const request = { bundleName: artifact.name, bundleUrl: served.url, version: artifact.version, expiresAt: Date.now() + timeoutMs, ...(args.resource ? { resource: { path: args.resource.path, type: args.resource.type, expectedUuid: args.resource.expectedUuid } } : {}) };
            const result = await executeGameViewOperation(session.targetId, createBundleOperationSource(request), timeoutMs + 3000, true) as Record<string, unknown> | null;
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Game View returned no typed bundle validation result.' });
            if (typeof result.code === 'string') throw new ToolError({ code: result.code, status: result.code.endsWith('NOT_FOUND') ? 404 : result.code.startsWith('UNSUPPORTED') ? 422 : 409,
                message: typeof result.message === 'string' ? result.message : 'Native bundle validation failed.',
                details: { mutationDispatched: result.mutationDispatched === true, cleanupVerified: result.cleanupVerified === true, pendingMayComplete: result.pendingMayComplete === true, retrySafe: result.retrySafe === true, ...(typeof result.cleanupFailure === 'string' ? { cleanupFailure: result.cleanupFailure } : {}) },
                recovery: result.retrySafe === true ? undefined : 'Do not retry a dispatched load blindly. Inspect the bound Game View; its prior native callback or owned bundle may remain pending.' });
            const resource = result.resource as Record<string, unknown> | null;
            if (result.bundleName !== artifact.name || ['loaded', 'identityVerified', 'released', 'removed', 'absent', 'unrelatedPreserved'].some(key => result[key] !== true) || (args.resource ? !resource || resource.path !== args.resource.path || resource.type !== args.resource.type || typeof resource.uuid !== 'string' || !resource.uuid || resource.loaded !== true : resource !== null)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime bundle response did not prove every requested lifecycle postcondition.' });
            if (args.resource?.expectedUuid !== undefined && resource?.uuid !== args.resource.expectedUuid) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Runtime resource UUID did not match the caller precondition.' });
            const after = await runtime.runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId, timeoutMs });
            const afterSession = after.session;
            if (after.success !== true || !after.ready || !afterSession || !('status' in afterSession) || !('targetId' in afterSession) || afterSession.status !== 'attached' || afterSession.sessionId !== session.sessionId || afterSession.targetId !== session.targetId || afterSession.targetKind !== session.targetKind) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'The attached Game View identity changed during bundle validation.' });
            return { success: true, sessionId: session.sessionId, targetId: session.targetId, bundlePath: args.bundlePath, bundleName: artifact.name, artifactRevision,
                loaded: true, identityVerified: true, resource: resource === null ? null : { path: resource.path, type: resource.type, uuid: resource.uuid, loaded: true },
                released: true, removed: true, absent: true, unrelatedPreserved: true };
        } finally { await served.close(); }
    }
}
