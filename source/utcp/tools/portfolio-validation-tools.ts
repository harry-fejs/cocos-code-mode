import fs from 'fs-extra';
import type { JsonSchema } from '@utcp/sdk';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { AssetTools } from './asset-tools';
import { ExpansionTools } from './expansion-tools';
import { inspectNativeAnimationGraph } from '../../native-animation-graph-inspect';
import { diagnoseNativeGraphReferences } from '../../native-animation-graph-diagnostics';
import { inspectGraphClipAssets } from '../../native-animation-graph-clips';
import { readGraphSnapshot } from '../../native-animation-graph-snapshot';
import { inspectGraphMotionClips } from '../../native-animation-graph-motions';
import { validateTerrainEditRequest } from '../../terrain-edit';
import type { TerrainCell, TerrainEditResult } from '../../terrain-edit';

import { requireCreator38 } from '../utils/creator38-capability';
const GRAPH_PRESET = 'db://internal/default_file_content/animation-graph/default.animgraph';
const ASSET_PATH_PATTERN = /^db:\/\/assets\/[A-Za-z0-9._/-]+$/;
const SKELETAL_FIELDS = ['playOnLoad', 'useBakedAnimation'] as const;
type SkeletalField = typeof SKELETAL_FIELDS[number];

const GRAPH_SOURCE_LIMIT = 5 * 1024 * 1024;
const GraphInspectionSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        reference: InstanceReferenceSchema,
        format: { type: 'string', enum: ['native-creator-3.7', 'legacy-synthetic', 'unsupported'] },
        nativeShape: { type: 'boolean' }, structuralValid: { type: 'boolean' },
        semanticsVerified: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false },
        layers: { type: 'array', maxItems: 32, items: { type: 'object' } },
        stateMachines: { type: 'array', maxItems: 128, items: { type: 'object' } },
        states: { type: 'array', maxItems: 256, items: { type: 'object' } },
        transitions: { type: 'array', maxItems: 512, items: { type: 'object' } },
        variables: { type: 'array', maxItems: 128, items: { type: 'object' } },
        conditions: { type: 'array', maxItems: 512, items: { type: 'object' } },
        layerCount: { type: 'integer' }, stateMachineCount: { type: 'integer' }, stateCount: { type: 'integer' },
        transitionCount: { type: 'integer' }, variableCount: { type: 'integer' }, conditionCount: { type: 'integer' },
        issues: { type: 'array', maxItems: 128, items: { type: 'object', properties: { code: { type: 'string' }, path: { type: 'string' } }, required: ['code', 'path'] } },
        truncated: { type: 'boolean' }, limits: { type: 'object' }, verificationScope: { type: 'string' },
    },
    required: ['reference', 'format', 'nativeShape', 'structuralValid', 'semanticsVerified', 'runtimeVerified', 'layers', 'stateMachines', 'states', 'transitions', 'variables', 'conditions', 'layerCount', 'stateMachineCount', 'stateCount', 'transitionCount', 'variableCount', 'conditionCount', 'issues', 'truncated', 'limits', 'verificationScope'],
} satisfies JsonSchema;

async function readGraphSource(file: unknown): Promise<unknown> {
    if (typeof file !== 'string' || !file) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: 'Animation graph source is unavailable.' });
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: 'Animation graph source is not a file.' });
        if (stat.size > GRAPH_SOURCE_LIMIT) throw new ToolError({ code: 'SOURCE_TOO_LARGE', status: 422, message: 'Animation graph source exceeds the 5 MiB inspection limit.' });
        const content = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(content, 'utf8') > GRAPH_SOURCE_LIMIT) throw new ToolError({ code: 'SOURCE_TOO_LARGE', status: 422, message: 'Animation graph source exceeds the 5 MiB inspection limit.' });
        return JSON.parse(content) as unknown;
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'SOURCE_INVALID', status: 422, message: 'Animation graph source could not be read as JSON.', details: { cause: error instanceof Error ? error.message : String(error) } });
    }
}

function invalid(message: string): never {
    throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message });
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function unwrap(value: unknown): unknown {
    if (value && typeof value === 'object' && 'value' in value) return (value as { value: unknown }).value;
    return value;
}

function componentType(component: any): string {
    return String(component?.type ?? component?.value?.__type__?.value ?? component?.value?.__type__ ?? component?.cid ?? '');
}

function componentId(component: any): string | undefined {
    const value = unwrap(component?.value?.uuid ?? component?.uuid);
    return typeof value === 'string' && value ? value : undefined;
}

function assetReference(asset: any, fallback?: string): IInstanceReference {
    const id = typeof asset?.uuid === 'string' ? asset.uuid : fallback;
    if (!id) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a stable asset UUID.' });
    return { id, type: typeof asset?.type === 'string' && asset.type ? asset.type : 'cc.Asset' };
}

async function info(reference: IInstanceReference): Promise<any> {
    if (!reference?.id || typeof reference.id !== 'string' || reference.id.length > 256) invalid('reference.id must be a non-empty string of at most 256 characters.');
    let value: any;
    try {
        value = await Editor.Message.request('asset-db', 'query-asset-info', reference.id);
    } catch (error) {
        throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: `Could not query asset ${reference.id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${reference.id} was not found.` });
    return value;
}

function safeGraphPath(assetPath: unknown): string {
    if (typeof assetPath !== 'string' || assetPath.length < 1 || assetPath.length > 256 || !ASSET_PATH_PATTERN.test(assetPath) || assetPath.includes('..')) {
        invalid('assetPath must be a project db://assets path without traversal.');
    }
    return assetPath.endsWith('.animgraph') ? assetPath : `${assetPath}.animgraph`;
}

function metadataNames(value: unknown, keys: string[]): string[] {
    if (!value || typeof value !== 'object') return [];
    for (const key of keys) {
        const candidate = (value as Record<string, unknown>)[key];
        if (!Array.isArray(candidate)) continue;
        if (candidate.length > 256) throw new ToolError({ code: 'UNSUPPORTED_METADATA', status: 422, message: 'Animation metadata inventory exceeds 256 entries; partial validation is refused.' });
        const names: string[] = [];
        for (let index = 0; index < candidate.length; index++) {
            if (!Object.prototype.hasOwnProperty.call(candidate, index)) throw new ToolError({ code: 'UNSUPPORTED_METADATA', status: 422, message: 'Animation metadata inventory contains a missing entry.' });
            const item = candidate[index];
            if (typeof item === 'string') names.push(item);
            else if (item && typeof item === 'object' && typeof (item as any).name === 'string') names.push((item as any).name);
            else throw new ToolError({ code: 'UNSUPPORTED_METADATA', status: 422, message: 'Animation metadata entry must be a string or an object with a string name.' });
        }
        if (names.length) return names;
    }
    return [];
}

const MAX_SKELETON_METADATA_BYTES = 5 * 1024 * 1024;

async function readSkeletonJointNames(asset: any): Promise<string[]> {
    const subAssets = asset?.subAssets && typeof asset.subAssets === 'object' ? Object.values(asset.subAssets) : [];
    for (const subAsset of subAssets as any[]) {
        if (subAsset?.importer !== 'gltf-skeleton' && !/skeleton/i.test(String(subAsset?.type ?? subAsset?.url ?? subAsset?.file ?? ''))) continue;
        // Creator 3.7 reports an empty `file` for imported sub-assets; the emitted library
        // JSON is exposed through the `library` extension map instead (verified live on
        // 3.7.3 with an imported glTF skin).
        const libraryFile = subAsset?.library && typeof subAsset.library === 'object'
            ? subAsset.library['.json'] ?? Object.values(subAsset.library).find((entry) => typeof entry === 'string')
            : undefined;
        const file = typeof subAsset?.file === 'string' && subAsset.file ? subAsset.file : libraryFile;
        if (typeof file !== 'string' || !file) continue;
        try {
            const handle = await fs.open(file, 'r');
            let parsed: unknown;
            try {
                const before = await fs.fstat(handle);
                if (!before.isFile() || before.size > MAX_SKELETON_METADATA_BYTES) throw new ToolError({ code: 'UNSUPPORTED_METADATA', status: 422, message: 'Skeleton output must be a file of at most 5 MiB.' });
                const bytes = Buffer.allocUnsafe(before.size + 1);
                let count = 0;
                while (count < bytes.length) {
                    const { bytesRead } = await fs.read(handle, bytes, count, bytes.length - count, null);
                    if (!bytesRead) break;
                    count += bytesRead;
                }
                const after = await fs.fstat(handle);
                const current = await fs.stat(file);
                if (count !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
                    || current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs) {
                    throw new ToolError({ code: 'SKELETON_METADATA_CHANGED', status: 409, message: 'Skeleton importer output changed while reading; no mixed metadata returned.' });
                }
                parsed = JSON.parse(bytes.subarray(0, count).toString('utf8'));
            } finally { await fs.close(handle); }
            const joints = metadataNames(parsed, ['_joints', 'joints', 'jointNames', 'bones', 'boneNames']);
            if (joints.length) return joints;
        } catch (error) {
            if (error instanceof ToolError) throw error;
            // Importer output may be unavailable while Creator is still reimporting.
        }
    }
    return [];
}

async function animationMetadata(asset: any): Promise<{ joints: string[], clips: string[], skeletonId?: string }> {
    const userData = asset?.meta?.userData;
    const candidates = [asset?.skeleton, asset?.skeletonData, userData?.skeleton, userData, asset];
    let joints: string[] = [];
    let clips: string[] = [];
    let skeletonId: string | undefined;
    for (const candidate of candidates) {
        if (!joints.length) joints = metadataNames(candidate, ['_joints', 'joints', 'jointNames', 'bones', 'boneNames']);
        if (!clips.length) clips = metadataNames(candidate, ['clips', 'clipNames', 'animations', 'animationNames', 'animationImportSettings']);
        if (!skeletonId && candidate && typeof candidate === 'object') {
            for (const key of ['skeletonId', 'skeletonUuid', 'skeletonUUID']) {
                if (typeof (candidate as any)[key] === 'string' && (candidate as any)[key]) {
                    skeletonId = (candidate as any)[key];
                    break;
                }
            }
            if (!skeletonId) {
                const skeletons = (candidate as any).assetFinder?.skeletons;
                if (Array.isArray(skeletons) && typeof skeletons[0] === 'string' && skeletons[0]) skeletonId = skeletons[0];
            }
        }
    }
    if (!joints.length) joints = await readSkeletonJointNames(asset);
    return { joints, clips, ...(skeletonId ? { skeletonId } : {}) };
}

function nodeComponents(node: any): any[] {
    return Array.isArray(node?.__comps__) ? node.__comps__ : Array.isArray(node?.components) ? node.components : [];
}

async function queryNode(id: string): Promise<any> {
    let node: any;
    try {
        node = await Editor.Message.request('scene', 'query-node', id);
    } catch (error) {
        throw new ToolError({ code: 'SCENE_QUERY_FAILED', status: 502, message: `Could not query scene node ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    if (!node || typeof node !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${id} was not found.` });
    return node;
}

export class PortfolioValidationTools {
    async assetBundleValidate(args: { reference: IInstanceReference, expectedBundle?: string }) {
        const asset = await info(args.reference);
        let meta: unknown;
        try {
            meta = await Editor.Message.request('asset-db', 'query-asset-meta', args.reference.id);
        } catch (error) {
            throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: `Could not query metadata for asset ${args.reference.id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        const userData = meta && typeof meta === 'object' && 'userData' in meta && meta.userData && typeof meta.userData === 'object' ? meta.userData : null;
        const isBundle = userData !== null && 'isBundle' in userData && userData.isBundle === true;
        const bundleName = userData !== null && 'bundleName' in userData && typeof userData.bundleName === 'string' && userData.bundleName ? userData.bundleName : null;
        const priority = userData !== null && 'priority' in userData && Number.isInteger(userData.priority) ? userData.priority : null;
        const compressionType = userData !== null && 'compressionType' in userData ? userData.compressionType : null;
        const remote = userData !== null && 'isRemoteBundle' in userData ? userData.isRemoteBundle : null;
        const bundle = isBundle ? { name: bundleName, priority, compressionType, remote } : null;
        const issues: Array<{ code: string, expected?: string, actual?: string | null }> = [];
        if (!isBundle) issues.push({ code: 'NOT_BUNDLE' });
        if (isBundle && !bundleName) issues.push({ code: 'BUNDLE_NAME_MISSING' });
        if (args.expectedBundle !== undefined && bundleName !== args.expectedBundle) issues.push({ code: 'BUNDLE_MISMATCH', expected: args.expectedBundle, actual: bundleName });
        return { valid: issues.length === 0, reference: { id: String(asset.uuid ?? args.reference.id), type: String(asset.type ?? 'cc.Asset') }, bundle, issues, runtimeCaveat: 'Metadata validation only; runtime loading is not claimed.' };
    }
    @utcpTool('physics2dQuery', 'Query bounded 2D physics topology.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '2d', 'query'])
    async physics2dQuery(args: { reference?: IInstanceReference } = {}) { return new ExpansionTools().physics2dTopologyAudit(args); }
    @utcpTool('physics3dQuery', 'Query bounded 3D physics topology.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '3d', 'query'])
    async physics3dQuery(args: { reference?: IInstanceReference } = {}) { return new ExpansionTools().physics3dTopologyAudit(args); }
    @utcpTool('shaderValidate', 'Validate one named Creator effect.', { type: 'object', additionalProperties: false, properties: { effectName: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['effectName'] }, { type: 'object', properties: { valid: { type: 'boolean' }, effectName: { type: 'string' }, diagnostics: { type: 'array' }, result: {} }, required: ['valid', 'effectName', 'diagnostics'] }, 'GET', ['shader', 'effect', 'validate'])
    async shaderValidate(args: { effectName: string }) {
        const effects: any = await Editor.Message.request('scene', 'query-all-effects' as never);
        const entries = effects && typeof effects === 'object' && !Array.isArray(effects) ? Object.values(effects) : [];
        const match: any = entries.find((effect: any) => effect?.name === args.effectName || effect?.assetPath === args.effectName);
        const known = !!match || (effects && typeof effects === 'object' && Object.prototype.hasOwnProperty.call(effects, args.effectName));
        const queryName = match?.name ?? args.effectName;
        const result: any = known ? await Editor.Message.request('scene', 'query-effect' as never, queryName) : null;
        const valid = known && result != null && result !== false;
        return { valid, effectName: args.effectName, diagnostics: valid ? [] : [{ code: 'EFFECT_NOT_FOUND', effectName: args.effectName }], result: result ?? null };
    }
    @utcpTool('animationGraphInspect', 'Inspect bounded native Creator 3.7 serialized layers, state machines, variables and conditions. Structural evidence only; semantics and runtime are not verified.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, GraphInspectionSchema, 'GET', ['animation', 'graph', 'inspect'])
    async animationGraphInspect(args: { reference: IInstanceReference }) {
        const asset = await info(args?.reference);
        const value = await readGraphSource(asset.file);
        return { reference: assetReference(asset, args.reference.id), ...inspectNativeAnimationGraph(value) };
    }
    @utcpTool('animationGraphEdit', 'Fails closed: legacy synthetic node/transition operations are not a native Creator graph serializer. Use Creator authoring tools; no source is written.', {
        type: 'object', additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            operations: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { operation: { type: 'string', enum: ['add_node', 'remove_node', 'update_node', 'add_transition', 'remove_transition'] }, node: {}, nodeId: { type: 'string', maxLength: 256 }, transition: {}, transitionId: { type: 'string', maxLength: 256 } }, required: ['operation'] } },
        },
        required: ['reference', 'operations'],
    }, { type: 'object', description: 'No successful edit response: native serialization is unsupported and every request fails before writing.' }, 'POST', ['animation', 'graph', 'edit', 'configure', 'asset'])
    async animationGraphEdit(args: { reference: IInstanceReference, operations: Array<{ operation: string, node?: unknown, nodeId?: string, transition?: unknown, transitionId?: string }> }): Promise<never> {
        if (!Array.isArray(args?.operations) || args.operations.length < 1 || args.operations.length > 32) invalid('operations must contain 1 to 32 items.');
        const asset = await info(args?.reference);
        const graph = inspectNativeAnimationGraph(await readGraphSource(asset.file));
        throw new ToolError({
            code: graph.nativeShape ? 'NATIVE_GRAPH_EDIT_UNSUPPORTED' : 'UNSUPPORTED_GRAPH_FORMAT', status: 422,
            message: graph.nativeShape ? 'Native Creator graph editing requires a verified native serializer; synthetic node/transition operations are refused.' : 'Source is not a supported native Creator animation graph; synthetic graph editing is refused.',
            details: { reference: assetReference(asset, args.reference.id), format: graph.format, semanticsVerified: false, runtimeVerified: false, written: false },
            recovery: 'Author the graph in Creator. Inspect serialized structure without treating it as playable graph validation.',
        });
    }
    @utcpTool('animationGraphValidate', 'Audit native serialized graph structure without granting playable/semantic/runtime validity. valid is always false until semantic verification is implemented.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { ...GraphInspectionSchema, properties: { ...GraphInspectionSchema.properties, valid: { type: 'boolean', const: false } }, required: [...GraphInspectionSchema.required, 'valid'] }, 'GET', ['animation', 'graph', 'validate'])
    async animationGraphValidate(args: { reference: IInstanceReference }) {
        const graph = await this.animationGraphInspect(args);
        return { ...graph, valid: false as const };
    }

    @utcpTool('animationGraphDiagnostics', 'Report variables, structural paths and Asset DB clip identities through bounded native 1D/2D/direct blend descendants. Unsupported motion shapes are explicit; no playable/runtime validity claim.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, {
        type: 'object', properties: { reference: InstanceReferenceSchema, complete: { type: 'boolean' }, issues: { type: 'array', maxItems: 256 }, truncated: { type: 'boolean' }, checkedStates: { type: 'integer' }, checkedConditions: { type: 'integer' }, clips: { type: 'array', maxItems: 2048 }, checkedClips: { type: 'integer' }, directClipsValid: { type: 'boolean' }, clipVerificationScope: { type: 'string' }, motionIssues: { type: 'array', maxItems: 128 }, motionTraversalComplete: { type: 'boolean' }, motionTraversalTruncated: { type: 'boolean' }, inspectedMotionObjects: { type: 'integer' }, semanticsVerified: { type: 'boolean', const: false }, runtimeVerified: { type: 'boolean', const: false }, verificationScope: { type: 'string' } }, required: ['reference', 'complete', 'issues', 'truncated', 'checkedStates', 'checkedConditions', 'clips', 'checkedClips', 'directClipsValid', 'clipVerificationScope', 'motionIssues', 'motionTraversalComplete', 'motionTraversalTruncated', 'inspectedMotionObjects', 'semanticsVerified', 'runtimeVerified', 'verificationScope'],
    }, 'GET', ['animation', 'graph', 'diagnostics', 'read-only'])
    async animationGraphDiagnostics(args: { reference: IInstanceReference }) {
        const asset = await info(args?.reference);
        const reference = assetReference(asset, args.reference.id);
        if (reference.id !== args.reference.id) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Graph Asset DB identity differs from requested UUID.' });
        const before = await readGraphSnapshot(asset.file);
        const graph = inspectNativeAnimationGraph(before.value);
        const motions = inspectGraphMotionClips(before.value);
        const clips = await inspectGraphClipAssets(motions.clipReferences, uuid => Editor.Message.request('asset-db', 'query-asset-info', uuid));
        const current = await info(args.reference);
        if (current.uuid !== reference.id || current.file !== asset.file || current.type !== asset.type) throw new ToolError({ code: 'GRAPH_SOURCE_CHANGED', status: 409, message: 'Graph asset identity/source changed during diagnostics.' });
        const after = await readGraphSnapshot(current.file);
        if (after.sourceSha256 !== before.sourceSha256) throw new ToolError({ code: 'GRAPH_SOURCE_CHANGED', status: 409, message: 'Graph source bytes changed during clip queries; no mixed snapshot returned.' });
        return { reference, ...diagnoseNativeGraphReferences(graph), ...clips, motionIssues: motions.motionIssues, motionTraversalComplete: motions.motionTraversalComplete, motionTraversalTruncated: motions.motionTraversalTruncated, inspectedMotionObjects: motions.inspectedMotionObjects };
    }

    @utcpTool('animationGraphCreate', 'Create a native Creator animation graph through asset-db and verify its stable imported identity.', {
        type: 'object', additionalProperties: false,
        properties: {
            assetPath: { type: 'string', minLength: 1, maxLength: 256, pattern: '^db://assets/[A-Za-z0-9._/-]+$' },
            options: { type: 'object', additionalProperties: false, properties: { overwrite: { type: 'boolean' }, rename: { type: 'boolean' } } },
        },
        required: ['assetPath'],
    }, {
        type: 'object', additionalProperties: false,
        properties: { reference: InstanceReferenceSchema, assetPath: { type: 'string' }, verified: { type: 'boolean' } },
        required: ['reference', 'assetPath', 'verified'],
    }, 'POST', ['animation', 'graph', 'create', 'asset'])
    async animationGraphCreate(args: { assetPath: string, options?: { overwrite?: boolean, rename?: boolean } }) {
        const requestedPath = safeGraphPath(args?.assetPath);
        const options = { overwrite: args?.options?.overwrite === true, rename: args?.options?.rename === true };
        const available = await Editor.Message.request('asset-db', 'generate-available-url', requestedPath);
        const targetPath = safeGraphPath(available);
        let created: any;
        try {
            created = await Editor.Message.request('asset-db', 'copy-asset', GRAPH_PRESET, targetPath, options);
            if (!created || typeof created !== 'object' || typeof created.uuid !== 'string' || !created.uuid) {
                throw new ToolError({ code: 'CREATE_FAILED', status: 502, message: 'Creator did not return an imported animation graph identity.' });
            }
            const readBack = await info({ id: created.uuid });
            if (typeof readBack.uuid !== 'string' || readBack.uuid !== created.uuid) {
                throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Animation graph creation read-back did not preserve the created UUID.' });
            }
            const reference = assetReference(readBack, created.uuid);
            return { reference, assetPath: typeof readBack.url === 'string' ? readBack.url : targetPath, verified: true };
        } catch (error) {
            if (created?.uuid) {
                try {
                    await Editor.Message.request('asset-db', 'delete-asset', created.url ?? targetPath);
                    const removed = await Editor.Message.request('asset-db', 'query-asset-info', created.uuid);
                    if (removed) throw new Error('asset remained after delete-asset');
                } catch (rollbackError) {
                    throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: `Animation graph creation failed and ${created.uuid} could not be rolled back.`, details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) } });
                }
            }
            throw error;
        }
    }

    @utcpTool('animationRetargetValidate', 'Compare bounded source, target, joint, and clip metadata without claiming automatic retargeting.', {
        type: 'object', additionalProperties: false,
        properties: { sourceReference: InstanceReferenceSchema, targetReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema },
        required: ['sourceReference', 'targetReference'],
    }, {
        type: 'object', additionalProperties: false,
        properties: {
            valid: { type: 'boolean' }, automaticRetargeting: { type: 'boolean' },
            sourceReference: InstanceReferenceSchema, targetReference: InstanceReferenceSchema, clipReference: InstanceReferenceSchema,
            source: { type: 'object' }, target: { type: 'object' }, clip: { type: 'object' }, issues: { type: 'array', maxItems: 256 },
        },
        required: ['valid', 'automaticRetargeting', 'sourceReference', 'targetReference', 'source', 'target', 'issues'],
    }, 'GET', ['animation', 'retarget', 'validate', 'skeleton'])
    async animationRetargetValidate(args: { sourceReference: IInstanceReference, targetReference: IInstanceReference, clipReference?: IInstanceReference }) {
        if (!args?.sourceReference?.id || !args?.targetReference?.id) invalid('sourceReference and targetReference are required.');
        const sourceInfo = await info(args.sourceReference);
        const targetInfo = await info(args.targetReference);
        const source = await animationMetadata(sourceInfo);
        const target = await animationMetadata(targetInfo);
        const clipInfo = args.clipReference ? await info(args.clipReference) : undefined;
        const clip = clipInfo ? await animationMetadata(clipInfo) : undefined;
        if (!source.joints.length || !target.joints.length) {
            throw new ToolError({
                code: 'UNSUPPORTED_METADATA',
                status: 422,
                message: 'Creator did not expose bounded skeleton joint metadata for both retarget inputs.',
                details: { sourceJointCount: source.joints.length, targetJointCount: target.joints.length },
                recovery: 'Use model assets with imported skeleton metadata exposed by asset-db.',
            });
        }
        const issues: Array<Record<string, unknown>> = [];
        const sourceSet = new Set(source.joints);
        const targetSet = new Set(target.joints);
        if (sourceSet.size !== source.joints.length) issues.push({ code: 'SOURCE_JOINTS_DUPLICATE' });
        if (targetSet.size !== target.joints.length) issues.push({ code: 'TARGET_JOINTS_DUPLICATE' });
        if (source.joints.some(joint => !joint)) issues.push({ code: 'SOURCE_JOINTS_EMPTY' });
        if (target.joints.some(joint => !joint)) issues.push({ code: 'TARGET_JOINTS_EMPTY' });
        const missing = source.joints.filter((joint) => !targetSet.has(joint)).slice(0, 256);
        const extra = target.joints.filter((joint) => !sourceSet.has(joint)).slice(0, 256);
        if (missing.length) issues.push({ code: 'TARGET_JOINTS_MISSING', joints: missing });
        if (extra.length) issues.push({ code: 'TARGET_JOINTS_EXTRA', joints: extra });
        if (source.skeletonId && target.skeletonId && source.skeletonId !== target.skeletonId) issues.push({ code: 'SKELETON_ID_MISMATCH', source: source.skeletonId, target: target.skeletonId });
        if (clip && !clip.clips.length) issues.push({ code: 'CLIP_METADATA_UNAVAILABLE' });
        if (clip?.skeletonId && target.skeletonId && clip.skeletonId !== target.skeletonId) issues.push({ code: 'CLIP_SKELETON_MISMATCH', clip: clip.skeletonId, target: target.skeletonId });
        if (clip && clip.joints.length) {
            if (new Set(clip.joints).size !== clip.joints.length) issues.push({ code: 'CLIP_JOINTS_DUPLICATE' });
            if (clip.joints.some(joint => !joint)) issues.push({ code: 'CLIP_JOINTS_EMPTY' });
            const missingClipJoints = clip.joints.filter(joint => !targetSet.has(joint));
            if (missingClipJoints.length) issues.push({ code: 'CLIP_TARGET_JOINTS_MISSING', joints: missingClipJoints });
        }
        return {
            valid: issues.length === 0,
            automaticRetargeting: false,
            sourceReference: assetReference(sourceInfo, args.sourceReference.id),
            targetReference: assetReference(targetInfo, args.targetReference.id),
            ...(args.clipReference && clipInfo ? { clipReference: assetReference(clipInfo, args.clipReference.id) } : {}),
            source: { jointCount: source.joints.length, joints: source.joints, ...(source.skeletonId ? { skeletonId: source.skeletonId } : {}) },
            target: { jointCount: target.joints.length, joints: target.joints, ...(target.skeletonId ? { skeletonId: target.skeletonId } : {}) },
            ...(clip ? { clip: { clipCount: clip.clips.length, clips: clip.clips, ...(clip.skeletonId ? { skeletonId: clip.skeletonId } : {}) } } : {}),
            issues,
        };
    }

    @utcpTool('skeletalAnimationConfigure', 'Configure bounded serialized SkeletalAnimation component fields with read-back and rollback.', {
        type: 'object', additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            properties: {
                type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 2,
                properties: { playOnLoad: { type: 'boolean' }, useBakedAnimation: { type: 'boolean' } },
            },
        },
        required: ['reference', 'properties'],
    }, {
        type: 'object', additionalProperties: false,
        properties: { reference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, properties: { type: 'object' }, changed: { type: 'array', maxItems: 2 }, verified: { type: 'boolean' } },
        required: ['reference', 'componentReference', 'properties', 'changed', 'verified'],
    }, 'POST', ['skeletal', 'animation', 'configure', 'scene'])
    async skeletalAnimationConfigure(args: { reference: IInstanceReference, properties: Partial<Record<SkeletalField, boolean>> }) {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') invalid('reference.id is required.');
        if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties)) invalid('properties must contain at least one supported field.');
        const keys = Object.keys(args.properties);
        if (!keys.length || keys.length > SKELETAL_FIELDS.length || keys.some((key) => !(SKELETAL_FIELDS as readonly string[]).includes(key))) {
            throw new ToolError({ code: 'UNSUPPORTED_PROPERTY', status: 422, message: 'Only playOnLoad and useBakedAnimation are supported serialized SkeletalAnimation fields.' });
        }
        for (const key of keys) if (typeof (args.properties as any)[key] !== 'boolean') invalid(`${key} must be a boolean.`);
        const node = await queryNode(args.reference.id);
        const components = nodeComponents(node);
        const index = components.findIndex((component) => componentType(component) === 'cc.SkeletalAnimation' || componentType(component) === 'SkeletalAnimation');
        if (index < 0) throw new ToolError({ code: 'UNSUPPORTED_COMPONENT', status: 422, message: `Node ${args.reference.id} has no serialized cc.SkeletalAnimation component.` });
        const component = components[index];
        const values = component?.value && typeof component.value === 'object' ? component.value : {};
        const previous: Record<string, unknown> = {};
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(values, key)) throw new ToolError({ code: 'UNSUPPORTED_PROPERTY', status: 422, message: `SkeletalAnimation does not expose serialized field ${key}.` });
            previous[key] = clone(values[key]);
        }
        const componentReference = { id: componentId(component) ?? `${args.reference.id}:component:${index}`, type: componentType(component) || 'cc.SkeletalAnimation' };
        const attempted: string[] = [];
        try {
            for (const key of keys) {
                attempted.push(key);
                const result = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: `__comps__.${index}.${key}`, dump: { value: (args.properties as any)[key], type: 'Boolean' } });
                if (result === false) throw new Error(`set-property refused ${key}`);
            }
            await Editor.Message.request('scene', 'snapshot');
            const readBackNode = await queryNode(args.reference.id);
            const readBackComponent = nodeComponents(readBackNode)[index];
            const readBackValues = readBackComponent?.value ?? {};
            for (const key of keys) if (unwrap(readBackValues[key]) !== (args.properties as any)[key]) throw new Error(`read-back mismatch for ${key}`);
            const readBackProperties: Record<string, boolean> = {};
            for (const key of keys) readBackProperties[key] = unwrap(readBackValues[key]) as boolean;
            return { reference: { id: args.reference.id, type: args.reference.type ?? 'cc.Node' }, componentReference, properties: readBackProperties, changed: keys, verified: true };
        } catch (error) {
            try {
                for (const key of attempted) {
                    const result = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: `__comps__.${index}.${key}`, dump: previous[key] as never });
                    if (result === false) throw new Error(`set-property refused rollback ${key}`);
                }
                await Editor.Message.request('scene', 'snapshot');
                const rollbackNode = await queryNode(args.reference.id);
                const rollbackValues = nodeComponents(rollbackNode)[index]?.value ?? {};
                for (const key of attempted) if (JSON.stringify(rollbackValues[key]) !== JSON.stringify(previous[key])) throw new Error(`rollback read-back mismatch for ${key}`);
            } catch (rollbackError) {
                throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: `SkeletalAnimation configuration failed and node ${args.reference.id} could not be restored.`, details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) } });
            }
            throw new ToolError({ code: 'MUTATION_FAILED', status: 502, message: `SkeletalAnimation configuration failed for node ${args.reference.id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }

    @utcpTool(
        'terrainCreate',
        'Create a bounded Terrain asset and attach a cc.Terrain component with serialized read-back.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                assetPath: { type: 'string', pattern: '^db://assets/(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._/-]+$' },
                name: { type: 'string', minLength: 1, maxLength: 128 },
                parentReference: InstanceReferenceSchema,
            },
            required: ['assetPath', 'name'],
        },
        {
            type: 'object',
            properties: {
                asset: { type: 'object' },
                node: { type: 'object' },
                component: { type: 'object' },
                verified: { type: 'boolean', const: true },
            },
            required: ['asset', 'node', 'component', 'verified'],
        },
        'POST',
        ['terrain', 'create', 'scene', 'asset', 'compound'],
    )
    async terrainCreate(args: { assetPath: string, name: string, parentReference?: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!ASSET_PATH_PATTERN.test(args.assetPath) || args.assetPath.includes('..')) invalid('assetPath must be a project-local db://assets path without traversal');
        if (!args.name.trim()) invalid('name must not be empty');
        let asset: { reference: IInstanceReference };
        try {
            asset = await new AssetTools().assetCreate({ assetPath: args.assetPath, preset: 'terrain' });
        } catch (error) {
            throw new ToolError({
                code: 'UNSUPPORTED_EDITOR_API',
                status: 422,
                message: 'Creator 3.7.3 does not expose a usable native Terrain asset preset.',
                details: { cause: error instanceof Error ? error.message : String(error), preset: 'terrain' },
                recovery: 'Provide a Creator version with a native terrain preset or import a supported terrain asset first.',
            });
        }
        const parent = args.parentReference?.id ?? (await Editor.Message.request('scene', 'query-node-tree') as any)?.uuid;
        if (typeof parent !== 'string' || !parent) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Scene root is unavailable for terrain creation.' });
        const created = await Editor.Message.request('scene', 'create-node', { name: args.name, parent });
        const nodeId = Array.isArray(created) ? created[0] : created;
        if (typeof nodeId !== 'string' || !nodeId) throw new ToolError({ code: 'CREATE_FAILED', status: 502, message: 'Creator did not return a terrain node identity.' });
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: nodeId, component: 'cc.Terrain' });
            await Editor.Message.request('scene', 'snapshot');
            const node = await Editor.Message.request('scene', 'query-node', nodeId) as any;
            const component = (node?.__comps__ ?? []).find((item: any) => String(item.type ?? item.value?.__type__?.value ?? item.value?.__type__ ?? item.cid) === 'cc.Terrain');
            if (!component) throw new Error('cc.Terrain read-back was missing after creation');
            return { asset, node: { id: nodeId, type: 'cc.Node' }, component: { id: component.value?.uuid?.value ?? component.uuid, type: 'cc.Terrain' }, verified: true };
        } catch (error) {
            await Editor.Message.request('scene', 'remove-node', { uuid: nodeId }).catch(() => undefined);
            throw new ToolError({ code: 'CREATE_FAILED', status: 502, message: `Terrain creation failed for ${args.name}.`, details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Use a Creator version exposing cc.Terrain scene creation and serialized read-back.' });
        }
    }

    @utcpTool('terrainEdit', 'Persist up to 256 native Terrain height cells through Creator TerrainManager, verify source bytes, and reimport/reload the exact asset. Legacy path edits remain unsupported.', {
        type: 'object',
        oneOf: [
            { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, assetReference: InstanceReferenceSchema,
                cells: { type: 'array', minItems: 1, maxItems: 256, items: { type: 'object', additionalProperties: false, properties: { i: { type: 'integer', minimum: 0 }, j: { type: 'integer', minimum: 0 }, height: { type: 'number', minimum: -256, maximum: 255.9921875 } }, required: ['i', 'j', 'height'] } } }, required: ['nodeReference', 'componentReference', 'assetReference', 'cells'] },
            { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, path: { type: 'string', minLength: 1, maxLength: 128, pattern: '^(height|layers)(?:\\.[A-Za-z0-9_]+)*$' }, value: {} }, required: ['reference', 'path', 'value'] },
        ],
    }, { type: 'object', properties: { success: { type: 'boolean' }, changed: { type: 'boolean' }, verified: { type: 'boolean' }, mutationStarted: { type: 'boolean' }, nodeUuid: { type: 'string' }, componentUuid: { type: 'string' }, assetUuid: { type: 'string' }, restoration: { type: 'string', enum: ['not-needed', 'confirmed', 'failed'] }, previous: { type: 'array' }, readBack: { type: 'array' }, sourceBeforeSha256: { type: 'string' }, sourceAfterSha256: { type: 'string' }, sourceBytes: { type: 'integer' }, reimported: { type: 'boolean' }, reloaded: { type: 'boolean' }, writer: { type: 'string' }, error: { type: 'object' } }, required: ['success', 'changed', 'verified', 'mutationStarted', 'nodeUuid', 'componentUuid', 'assetUuid', 'restoration'] }, 'POST', ['terrain', 'edit', 'height', 'persist'])
    async terrainEdit(args: { nodeReference: IInstanceReference; componentReference: IInstanceReference; assetReference: IInstanceReference; cells: TerrainCell[] } | { reference: IInstanceReference; path: string; value: unknown }): Promise<TerrainEditResult> {
        if (args && 'path' in args) {
            if (!args.reference?.id || typeof args.path !== 'string' || !/^(height|layers)(?:\.[A-Za-z0-9_]+)*$/.test(args.path)) invalid('Legacy terrainEdit requires a height/layers path and reference.');
            throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Generic terrain height/layers property paths are not a native persistent edit route.', recovery: 'Use exact nodeReference, componentReference, assetReference and bounded cells instead.' });
        }
        if (!args || args.nodeReference?.type !== 'cc.Node' || args.componentReference?.type !== 'cc.Terrain' || args.assetReference?.type !== 'cc.TerrainAsset') invalid('terrainEdit requires exact cc.Node, cc.Terrain and cc.TerrainAsset typed references.');
        requireCreator38('terrainEdit');
        const request = { nodeUuid: args.nodeReference.id, componentUuid: args.componentReference.id, assetUuid: args.assetReference.id, cells: args.cells };
        try { validateTerrainEditRequest(request); } catch (error: unknown) { invalid(error instanceof Error ? error.message : String(error)); }
        const raw = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'terrainHeightEdit', args: [request] }) as unknown;
        if (!raw || typeof raw !== 'object' || !('nodeUuid' in raw) || raw.nodeUuid !== request.nodeUuid || !('componentUuid' in raw) || raw.componentUuid !== request.componentUuid || !('assetUuid' in raw) || raw.assetUuid !== request.assetUuid || !('success' in raw) || typeof raw.success !== 'boolean' || !('mutationStarted' in raw) || typeof raw.mutationStarted !== 'boolean' || !('restoration' in raw) || !['not-needed', 'confirmed', 'failed'].includes(String(raw.restoration))) {
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Terrain scene operation returned invalid identity/evidence; mutation state is unknown.' });
        }
        const result = raw as TerrainEditResult;
        if (!result.success) throw new ToolError({ code: result.error?.code ?? 'TERRAIN_OPERATION_FAILED', status: result.mutationStarted ? 502 : 422, message: result.error?.message ?? 'Native terrain persistence failed.', details: { ...result } });
        if (!result.verified || !Array.isArray(result.readBack) || result.readBack.length !== request.cells.length || typeof result.sourceBeforeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sourceBeforeSha256) || typeof result.sourceAfterSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sourceAfterSha256) || result.writer !== 'Creator.TerrainManager.saveAsset' || (result.changed && (!result.reimported || !result.reloaded))) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Terrain success lacked native source/reload verification.' });
        const expectedCells = request.cells.map(cell => ({ i: cell.i, j: cell.j, height: (Math.trunc(32768 + cell.height * 128) - 32768) / 128 }));
        if (typeof result.changed !== 'boolean' || result.restoration !== 'not-needed' || !result.readBack!.every((cell, index) => cell.i === expectedCells[index].i && cell.j === expectedCells[index].j && cell.height === expectedCells[index].height) || !Number.isInteger(result.sourceBytes) || result.sourceBytes! < 28 || result.sourceBytes! > 8 * 1024 * 1024 || (result.changed && result.sourceBeforeSha256 === result.sourceAfterSha256)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Terrain returned inconsistent native cell/source postconditions.' });
        return result;
    }

    @utcpTool('modelImportConfigure', 'Configure one typed model importer property with reimport and read-back.', {
        type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, path: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*$' }, value: {} }, required: ['reference', 'path', 'value']
    }, { type: 'object', properties: { changed: { type: 'boolean' }, path: { type: 'string' }, previous: {}, readBack: {}, result: { type: 'object' } }, required: ['changed', 'path', 'previous', 'readBack', 'result'] }, 'POST', ['model', 'import', 'configure', 'reimport'])
    async modelImportConfigure(args: { reference: IInstanceReference, path: string, value: unknown }) {
        const asset = await info(args.reference);
        if (!/fbx|gltf|model/i.test(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Reference is not a model asset.' });
        return new AssetTools().assetImportSettingsSet(args);
    }

    @utcpTool('modelImportInspect', 'Inspect typed model importer settings and output metadata.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: InstanceReferenceSchema, importer: { type: 'string' }, settings: { type: 'object' }, schema: { type: 'object' }, outputs: { type: 'array' }, totalOutputs: { type: 'integer' }, outputsTruncated: { type: 'boolean' } }, required: ['reference', 'importer', 'settings', 'schema', 'outputs', 'totalOutputs', 'outputsTruncated'] }, 'GET', ['model', 'import', 'inspect'])
    async modelImportInspect(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const asset = await info(args.reference);
        if (!/fbx|gltf|model/i.test(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Reference is not a model asset.' });
        const result = await new AssetTools().assetImportSettingsGet({ reference: args.reference });
        const subAssets = asset.subAssets && typeof asset.subAssets === 'object' ? Object.values(asset.subAssets as Record<string, unknown>) : [];
        return { reference: result.reference, importer: result.importer, settings: result.settings, schema: result.schema, outputs: subAssets.slice(0, 128), totalOutputs: subAssets.length, outputsTruncated: subAssets.length > 128 };
    }

    @utcpTool('modelImportValidate', 'Validate typed model importer settings and imported mesh/skeleton/LOD outputs.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, importer: { type: 'string' }, issues: { type: 'array' }, outputs: { type: 'array' } }, required: ['valid', 'reference', 'importer', 'issues', 'outputs'] }, 'GET', ['model', 'import', 'validate'])
    async modelImportValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.modelImportInspect(args);
        const outputs = Array.isArray(inspected.outputs) ? inspected.outputs : [];
        const issues: Array<Record<string, unknown>> = [];
        if (!outputs.length) issues.push({ code: 'OUTPUTS_UNAVAILABLE', message: 'No imported model sub-assets were exposed by asset-db.' });
        if (inspected.outputsTruncated) issues.push({ code: 'OUTPUTS_TRUNCATED', message: 'Importer output inventory exceeds validation bound.' });
        for (const [index, output] of outputs.entries()) {
            if (!output || typeof output !== 'object' || Array.isArray(output)) { issues.push({ code: 'OUTPUT_IDENTITY_INVALID', index }); continue; }
            const row = output as Record<string, unknown>;
            if (typeof row.uuid !== 'string' || !row.uuid || typeof row.url !== 'string' || !row.url || typeof row.type !== 'string' || !row.type) issues.push({ code: 'OUTPUT_IDENTITY_INVALID', index });
        }
        const settings = inspected.settings;
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) issues.push({ code: 'SETTINGS_UNAVAILABLE' });
        return { valid: issues.length === 0, reference: inspected.reference, importer: inspected.importer, issues, outputs };
    }
    @utcpTool('modelImportOutputsInspect', 'Inspect bounded imported model mesh, skeleton, animation, and scene outputs with stable identities.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxOutputs: { type: 'integer', minimum: 1, maximum: 128, default: 64 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, outputs: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'outputs', 'total', 'truncated'] }, 'GET', ['model', 'import', 'outputs', 'skeleton', 'animation'])
    async modelImportOutputsInspect(args: { reference: IInstanceReference, maxOutputs?: number }): Promise<Record<string, unknown>> {
        const asset = await info(args.reference);
        if (!/fbx|gltf|model/i.test(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Reference is not a model asset.' });
        const maxOutputs = args.maxOutputs ?? 64;
        if (!Number.isInteger(maxOutputs) || maxOutputs < 1 || maxOutputs > 128) invalid('maxOutputs must be an integer from 1 to 128.');
        const raw = asset.subAssets && typeof asset.subAssets === 'object' ? Object.values(asset.subAssets as Record<string, any>) : [];
        const outputs = raw.slice(0, maxOutputs).map((output: any, index) => {
            if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.uuid !== 'string' || !output.uuid || typeof output.url !== 'string' || !output.url || typeof output.type !== 'string' || !output.type) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Imported model output ${index} has incomplete identity.` });
            return { uuid: output.uuid, url: output.url, type: output.type, importer: output.importer ?? null, name: output.name ?? null, userData: output.userData ?? null };
        });
        return { reference: assetReference(asset, args.reference.id), outputs, total: raw.length, truncated: raw.length > outputs.length };
    }

    @utcpTool('modelSkeletonInspect', 'Inspect bounded model skeleton joint paths and skeleton identity from imported model metadata.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxJoints: { type: 'integer', minimum: 1, maximum: 256, default: 128 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, skeletonId: { type: ['string', 'null'] }, joints: { type: 'array' }, totalJoints: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'skeletonId', 'joints', 'totalJoints', 'truncated'] }, 'GET', ['model', 'skeleton', 'joints', 'inspect'])
    async modelSkeletonInspect(args: { reference: IInstanceReference, maxJoints?: number }): Promise<Record<string, unknown>> {
        const asset = await info(args.reference);
        if (!/fbx|gltf|model/i.test(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Reference is not a model asset.' });
        const maxJoints = args.maxJoints ?? 128;
        if (!Number.isInteger(maxJoints) || maxJoints < 1 || maxJoints > 256) invalid('maxJoints must be an integer from 1 to 256.');
        const metadata = await animationMetadata(asset);
        if (!metadata.joints.length) throw new ToolError({ code: 'UNSUPPORTED_METADATA', status: 422, message: `Model ${args.reference.id} exposes no imported skeleton joint metadata.` });
        return { reference: assetReference(asset, args.reference.id), skeletonId: metadata.skeletonId ?? null, joints: metadata.joints.slice(0, maxJoints), totalJoints: metadata.joints.length, truncated: metadata.joints.length > maxJoints };
    }

    @utcpTool('modelSkeletonValidate', 'Validate bounded imported model skeleton identity and joint uniqueness.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, skeletonId: { type: ['string', 'null'] }, jointCount: { type: 'integer' }, issues: { type: 'array' } }, required: ['valid', 'reference', 'skeletonId', 'jointCount', 'issues'] }, 'GET', ['model', 'skeleton', 'validate', 'joints'])
    async modelSkeletonValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.modelSkeletonInspect({ reference: args.reference, maxJoints: 256 });
        const joints = inspected.joints as string[];
        const issues: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const [index, joint] of joints.entries()) {
            if (!joint) issues.push({ code: 'EMPTY_JOINT_PATH', index });
            else if (seen.has(joint)) issues.push({ code: 'DUPLICATE_JOINT_PATH', index, joint });
            else seen.add(joint);
        }
        return { valid: issues.length === 0, reference: inspected.reference, skeletonId: inspected.skeletonId, jointCount: inspected.totalJoints, issues };
    }

    @utcpTool('modelAnimationInspect', 'Inspect bounded imported model animation clip metadata and skeleton identity.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxClips: { type: 'integer', minimum: 1, maximum: 256, default: 128 } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, skeletonId: { type: ['string', 'null'] }, clips: { type: 'array' }, totalClips: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'skeletonId', 'clips', 'totalClips', 'truncated'] }, 'GET', ['model', 'animation', 'clips', 'inspect'])
    async modelAnimationInspect(args: { reference: IInstanceReference, maxClips?: number }): Promise<Record<string, unknown>> {
        const asset = await info(args.reference);
        if (!/fbx|gltf|model|animation/i.test(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Reference is not a model or imported model animation asset.' });
        const maxClips = args.maxClips ?? 128;
        if (!Number.isInteger(maxClips) || maxClips < 1 || maxClips > 256) invalid('maxClips must be an integer from 1 to 256.');
        const metadata = await animationMetadata(asset);
        return { reference: assetReference(asset, args.reference.id), skeletonId: metadata.skeletonId ?? null, clips: metadata.clips.slice(0, maxClips), totalClips: metadata.clips.length, truncated: metadata.clips.length > maxClips };
    }

    @utcpTool('modelAnimationValidate', 'Validate bounded imported model animation clip names and skeleton identity.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, skeletonId: { type: ['string', 'null'] }, clipCount: { type: 'integer' }, issues: { type: 'array' } }, required: ['valid', 'reference', 'skeletonId', 'clipCount', 'issues'] }, 'GET', ['model', 'animation', 'validate', 'clips'])
    async modelAnimationValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const inspected = await this.modelAnimationInspect({ reference: args.reference, maxClips: 256 });
        const clips = inspected.clips as string[];
        const issues: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const [index, clip] of clips.entries()) {
            if (!clip) issues.push({ code: 'EMPTY_CLIP_NAME', index });
            else if (seen.has(clip)) issues.push({ code: 'DUPLICATE_CLIP_NAME', index, clip });
            else seen.add(clip);
        }
        if (!clips.length) issues.push({ code: 'CLIP_METADATA_UNAVAILABLE' });
        return { valid: issues.length === 0, reference: inspected.reference, skeletonId: inspected.skeletonId, clipCount: inspected.totalClips, issues };
    }

}
