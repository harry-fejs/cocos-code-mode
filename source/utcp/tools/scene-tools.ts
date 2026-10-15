import packageJSON from '../../../package.json';
import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { ISceneTreeItem, SceneTreeItemSchema, Base64ImageSchema, IBase64Image, InstanceReferenceSchema, IInstanceReference, ISuccessIndicator, SuccessIndicatorSchema } from '../schemas';
import type { IPropertyValueType } from '@cocos/creator-types/editor/packages/scene/@types/public';
import { ToolError } from '../tool-error';
import { DEFAULT_TREE_MAX_DEPTH, DEFAULT_TREE_MAX_NODES, restorePrefabNode } from '../utils/tools-utils';
import { VERBOSE_TREE_DEPTH, VERBOSE_TREE_NODES } from '../utils/verbose';

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 2000;
const MAX_TREE_CHILD_OFFSET = 1_000_000;

const ALLOWED_COMPONENT_METHODS: Record<string, true> = {
    onLoad: true, start: true, onEnable: true, onDisable: true, onDestroy: true,
    resetInEditor: true, onFocusInEditor: true, onLostFocusInEditor: true,
    unscheduleAllCallbacks: true,
};
const MAX_COMPONENT_METHOD_ARGS = 32;
const MAX_COMPONENT_METHOD_RESULT_BYTES = 64 * 1024;
const MAX_COMPONENT_METHOD_BYTES = 32 * 1024;

function boundedListLimit(limit: number | undefined): number {
    return Math.min(Math.max(limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
}

function componentUuid(component: any): string | undefined {
    const nested = component?.value?.uuid?.value ?? component?.value?.uuid ?? component?.uuid;
    if (typeof nested === 'string' && nested) return nested;
    // Creator 3.7 query-node-tree serializes some native components as
    // { type, value: '<component-uuid>', extends } instead of a nested
    // value.uuid wrapper. Preserve the authoritative scalar UUID.
    return typeof component?.value === 'string' && component.value ? component.value : undefined;
}

function componentClassId(component: any): string | undefined {
    const value = component?.value;
    return value?.__type__?.value ?? value?.__type__ ?? component?.cid ?? value?.cid ?? component?.type;
}

function componentCandidates(componentType: any): string[] {
    return [componentType?.name, componentType?.type, componentType?.cid, componentType?.classId]
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function findComponentType(componentTypes: any[], requested: string): any | undefined {
    return componentTypes.find((candidate) => componentCandidates(candidate).includes(requested));
}

function unwrapSceneValue(value: unknown): unknown {
    if (value && typeof value === 'object' && 'value' in value) return value.value;
    return value;
}

function cameraComponentField(component: unknown, key: string): unknown {
    if (!component || typeof component !== 'object') return undefined;
    const row = component as Record<string, unknown>;
    const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
    return unwrapSceneValue(row[key] ?? value?.[key]);
}

function cameraComponentsFromNode(node: unknown): unknown[] {
    if (!node || typeof node !== 'object') return [];
    const row = node as Record<string, unknown>;
    return Array.isArray(row.__comps__) ? row.__comps__ : Array.isArray(row.components) ? row.components : [];
}

function isCameraComponent(component: unknown): boolean {
    const type = componentClassId(component);
    return type === 'cc.Camera' || type === 'Camera';
}

function cameraReference(component: unknown): IInstanceReference {
    const id = componentUuid(component);
    if (!id) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned a camera component without an authoritative UUID.' });
    return { id, type: 'cc.Camera' };
}

function* cameraSceneNodes(root: unknown): Generator<Record<string, unknown>> {
    const stack: unknown[] = [root];
    const seen = new Set<object>();
    let scheduled = 1;
    while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== 'object') continue;
        if (seen.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Camera hierarchy contains a repeated node object.' });
        seen.add(node);
        const row = node as Record<string, unknown>;
        if (Array.isArray(row.children)) {
            scheduled += row.children.length;
            if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Camera hierarchy exceeds the scene traversal budget.' });
            for (const child of row.children) stack.push(child);
        }
        yield row;
    }
}

interface SceneTreeNode {
    uuid?: string;
    name?: string | { value?: string };
    children?: SceneTreeNode[];
}

function sceneTreeNodeName(node: SceneTreeNode): string {
    if (typeof node.name === 'string') return node.name;
    return node.name?.value ?? node.uuid ?? '';
}

function findSceneTreeNode(root: SceneTreeNode, uuid: string): SceneTreeNode | null {
    const stack: SceneTreeNode[] = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (node.uuid === uuid) return node;
        for (const child of node.children ?? []) stack.push(child);
    }
    return null;
}

function nodeUuidFromSceneUsage(value: unknown, message: string): string {
    const uuid = typeof value === 'string' ? value :
        value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>).uuid ?? (value as Record<string, unknown>).id : undefined;
    if (typeof uuid !== 'string' || !uuid.trim()) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned an invalid node identity from ${message}.` });
    }
    return uuid;
}

async function assetInfoForSceneUsage(id: string): Promise<Record<string, unknown>> {
    let info: unknown;
    try {
        info = await Editor.Message.request('asset-db', 'query-asset-info', id);
    } catch (error) {
        throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: `Creator could not verify asset ${id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
    }
    if (info == null) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${id} was not found.` });
    if (typeof info !== 'object' || Array.isArray(info) || (info as Record<string, unknown>).uuid !== id) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned a mismatched asset identity for ${id}.` });
    }
    return info as Record<string, unknown>;
}

async function queryNodesForAsset(assetId: string, limit: number): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
    const nodeUuids: unknown = await Editor.Message.request('scene', 'query-nodes-by-asset-uuid', assetId);
    if (!Array.isArray(nodeUuids) || nodeUuids.some((uuid) => typeof uuid !== 'string' || !uuid.trim())) {
        throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned an invalid node UUID list for asset ${assetId}.` });
    }
    const references: IInstanceReference[] = nodeUuids.slice(0, limit).map((id: string) => ({ id, type: 'cc.Node' }));
    return { references, total: nodeUuids.length, truncated: nodeUuids.length > limit };
}

export class SceneTools {

    async sceneOpen(args: { reference: IInstanceReference }): Promise<ISuccessIndicator> {
        if (!args.reference || !args.reference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneOpen requires reference.id (scene uuid)' });
        }
        await Editor.Message.request('scene', 'open-scene', args.reference.id);
        const current = await Editor.Message.request('scene', 'query-current-scene');
        const currentId = typeof current === 'string' ? current : current?.uuid ?? current?.id;
        if (currentId !== args.reference.id) {
            throw new ToolError({
                code: 'SCENE_OPEN_UNCONFIRMED',
                status: 502,
                message: `Creator did not confirm scene ${args.reference.id} as the active scene.`,
                details: { requestedId: args.reference.id, currentId: currentId ?? null },
                recovery: 'Query sceneGetInfo and retry with an available scene asset.',
            });
        }
        return { success: true };
    }

    @utcpTool(
        'sceneGetInfo',
        'Get scene bounds, dirty state, current scene asset, and bounded hierarchy node count.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                bounds: {
                    type: 'object',
                    properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
                    required: ['x', 'y', 'width', 'height']
                },
                name: { type: 'string' }, uuid: { type: 'string' },
                dirty: { type: 'boolean' }, isDirty: { type: 'boolean' }, nodeCount: { type: 'integer', minimum: 0 },
                currentScene: { type: 'object', properties: { uuid: { type: 'string' }, url: { type: 'string' }, name: { type: 'string' } } }
            },
            required: ['bounds', 'dirty', 'isDirty', 'nodeCount']
        }, "GET", ['scene', 'info', 'bounds', 'size', 'dirty', 'unsaved', 'current', 'nodes', 'count']
    )
    async sceneGetInfo(): Promise<{ bounds: { x: number, y: number, width: number, height: number }, name?: string, uuid?: string, dirty: boolean, isDirty: boolean, nodeCount: number, currentScene?: { uuid?: string, url?: string, name?: string } }> {
        const [bounds, dirty, currentRaw, tree] = await Promise.all([
            Editor.Message.request('scene', 'query-scene-bounds'),
            Editor.Message.request('scene', 'query-dirty'),
            Editor.Message.request('scene', 'query-current-scene').catch(() => undefined),
            Editor.Message.request('scene', 'query-node-tree').catch(() => undefined),
        ]);
        if (!bounds) throw new Error('Failed to query scene bounds');
        let currentScene: { uuid?: string, url?: string, name?: string } | undefined;
        if (typeof currentRaw === 'string' && currentRaw) currentScene = { uuid: currentRaw };
        else if (currentRaw && typeof currentRaw === 'object') currentScene = currentRaw as { uuid?: string, url?: string, name?: string };
        const countNodes = (node: unknown): number => {
            if (!node || typeof node !== 'object') return 0;
            const children = 'children' in node && Array.isArray(node.children) ? node.children : [];
            return 1 + children.reduce((total: number, child: unknown) => total + countNodes(child), 0);
        };
        const nodeCount = countNodes(tree);
        return {
            bounds,
            ...(currentScene?.name ? { name: currentScene.name } : {}),
            ...(currentScene?.uuid ? { uuid: currentScene.uuid } : {}),
            dirty: !!dirty,
            isDirty: !!dirty,
            nodeCount,
            currentScene,
        };
    }

    @utcpTool(
        'nodeSetTransform',
        'Set bounded node position, rotation, scale, and active state through exact scene property paths with read-back.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                rotation: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                scale: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }, required: ['x', 'y', 'z'] },
                active: { type: 'boolean' },
            },
            required: ['reference'],
        },
        { type: 'object', properties: { updated: { type: 'boolean', const: true }, reference: InstanceReferenceSchema }, required: ['updated', 'reference'] },
        'POST', ['scene', 'node', 'transform', 'position', 'rotation', 'scale', 'active', 'set']
    )
    async nodeSetTransform(args: { reference: IInstanceReference, position?: { x: number, y: number, z: number }, rotation?: { x: number, y: number, z: number }, scale?: { x: number, y: number, z: number }, active?: boolean }): Promise<{ updated: true, reference: IInstanceReference }> {
        if (!args?.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeSetTransform requires reference.id.' });
        const changes: Array<{ path: string, value: any, type: string }> = [];
        if (args.position) changes.push({ path: 'position', value: args.position, type: 'cc.Vec3' });
        if (args.rotation) changes.push({ path: 'eulerAngles', value: args.rotation, type: 'cc.Vec3' });
        if (args.scale) changes.push({ path: 'scale', value: args.scale, type: 'cc.Vec3' });
        if (args.active !== undefined) changes.push({ path: 'active', value: args.active, type: 'Boolean' });
        if (changes.length === 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeSetTransform requires at least one transform field.' });
        const before = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!before) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} not found.` });
        for (const change of changes) {
            const accepted = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: change.path, dump: { value: change.value, type: change.type } });
            if (accepted === false) throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_FAILED', status: 502, message: `Creator rejected node property ${change.path}.` });
        }
        await Editor.Message.request('scene', 'snapshot');
        const after = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!after || typeof after !== 'object') throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_UNCONFIRMED', status: 502, message: `Creator did not return node ${args.reference.id} after transform update.` });
        const row = after as unknown as Record<string, unknown>;
        const unwrap = (value: unknown): unknown => value && typeof value === 'object' && 'value' in value ? value.value : value;
        for (const change of changes) {
            if (JSON.stringify(unwrap(row[change.path])) !== JSON.stringify(change.value)) throw new ToolError({ code: 'NODE_TRANSFORM_UPDATE_UNCONFIRMED', status: 502, message: `Node property ${change.path} did not match read-back.` });
        }
        return { updated: true, reference: { id: args.reference.id, type: 'cc.Node' } };
    }

    @utcpTool('sceneCreate', 'Create a scene asset from the built-in Creator template and confirm asset identity.', { type: 'object', properties: { assetPath: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['assetPath'] }, { type: 'object', properties: { success: { type: 'boolean' }, reference: InstanceReferenceSchema }, required: ['success', 'reference'] }, 'POST', ['scene', 'create', 'asset'])
    async sceneCreate(args: { assetPath: string }): Promise<{ success: true, reference: IInstanceReference }> {
        if (typeof args?.assetPath !== 'string' || !/^db:\/\/assets\/.+\.scene$/.test(args.assetPath) || args.assetPath.includes('..')) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'assetPath must be a db://assets scene path without traversal.' });
        }
        const legacy = Editor.App?.version === '3.7.3';
        const template = legacy ? 'db://internal/default_file_content/scene' : 'db://internal/default_file_content/scene/default.scene';
        const templateInfo = await Editor.Message.request('asset-db', 'query-asset-info', template) as { type?: string; isDirectory?: boolean; url?: string } | null;
        if (templateInfo?.type !== (legacy ? 'cc.Asset' : 'cc.SceneAsset') || templateInfo.isDirectory !== false || templateInfo.url !== template) throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Creator default scene template identity is unavailable.' });
        const created = await Editor.Message.request('asset-db', 'copy-asset', template, args.assetPath, { overwrite: false, rename: false }) as unknown;
        if (!created || typeof created !== 'object' || !('uuid' in created) || typeof created.uuid !== 'string') {
            throw new ToolError({ code: 'SCENE_CREATE_FAILED', status: 502, message: `Creator did not create scene ${args.assetPath}.` });
        }
        const info = await Editor.Message.request('asset-db', 'query-asset-info', created.uuid) as unknown;
        if (!info || typeof info !== 'object' || !('uuid' in info) || info.uuid !== created.uuid || !('type' in info) || info.type !== 'cc.SceneAsset' || !('isDirectory' in info) || info.isDirectory !== false) {
            throw new ToolError({ code: 'SCENE_CREATE_UNCONFIRMED', status: 502, message: `Creator did not confirm scene ${created.uuid}.` });
        }
        return { success: true, reference: { id: created.uuid, type: 'cc.SceneAsset' } };
    }

    @utcpTool('nodeGetInfo', 'Read one open-scene node with authoritative editor dump.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'node', 'info', 'inspect'])
    async nodeGetInfo(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        return this.sceneInspectNode(args);
    }

    @utcpTool('queryComponents', 'List globally registered component classes with bounded filtering.', { type: 'object', properties: { includeInternal: { type: 'boolean' }, filter: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT } } }, { type: 'object', properties: { componentTypes: { type: 'array', items: { type: 'string' } }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['componentTypes', 'total', 'truncated'] }, 'GET', ['scene', 'component', 'query', 'types', 'inspect'])
    async queryComponents(args: { includeInternal?: boolean, filter?: string, limit?: number } = {}): Promise<{ componentTypes: string[], total: number, truncated: boolean }> {
        const raw = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(raw)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no component type list.' });
        const filter = typeof args.filter === 'string' && args.filter ? args.filter.toLowerCase() : undefined;
        const limit = boundedListLimit(args.limit);
        const names = raw.flatMap((candidate: unknown) => componentCandidates(candidate)).filter((name, index, all) => all.indexOf(name) === index && (!filter || name.toLowerCase().includes(filter)));
        return { componentTypes: names.slice(0, limit), total: names.length, truncated: names.length > limit };
    }
    @utcpTool('sceneInspectNode', 'Inspect one open-scene node with authoritative editor dump.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'inspect', 'node', 'info'])
    async sceneInspectNode(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown;
        if (!node || typeof node !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} was not found.` });
        return node as Record<string, unknown>;
    }

    @utcpTool('sceneNodeType', 'Read the authoritative class type of one open-scene node.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: InstanceReferenceSchema, type: { type: 'string' } }, required: ['reference', 'type'] }, 'GET', ['scene', 'node', 'type', 'inspect'])
    async sceneNodeType(args: { reference: IInstanceReference }): Promise<{ reference: IInstanceReference, type: string }> {
        const node = await this.sceneInspectNode(args);
        const typeValue = node.__type__;
        const type = typeValue && typeof typeValue === 'object' && 'value' in typeValue ? typeValue.value : typeValue;
        if (typeof type !== 'string' || !type) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no authoritative node type.' });
        return { reference: { id: args.reference.id, type: 'cc.Node' }, type };
    }

    @utcpTool('sceneComponentInfo', 'Read one component dump by authoritative UUID.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object' }, 'GET', ['scene', 'component', 'inspect', 'info'])
    async sceneComponentInfo(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!args.reference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        const component = await Editor.Message.request('scene', 'query-component', args.reference.id) as unknown;
        if (!component || typeof component !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Component ${args.reference.id} was not found.` });
        return component as Record<string, unknown>;
    }

    @utcpTool(
        'cameraCreate',
        'Create a scene node with a cc.Camera component and verify both identities by read-back.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', minLength: 1 },
                is2D: { type: 'boolean' },
                parentReference: InstanceReferenceSchema,
            },
        },
        {
            type: 'object',
            properties: { nodeReference: InstanceReferenceSchema, cameraReference: InstanceReferenceSchema },
            required: ['nodeReference', 'cameraReference'],
        },
        'POST', ['scene', 'camera', 'create', 'node']
    )
    async cameraCreate(args: { name?: string, is2D?: boolean, parentReference?: IInstanceReference }): Promise<{ nodeReference: IInstanceReference, cameraReference: IInstanceReference }> {
        const nodeReference = await this.sceneCreateNode({ name: args.name ?? 'Camera', parentReference: args.parentReference });
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: nodeReference.reference.id, component: 'cc.Camera' });
            const node = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
            const camera = cameraComponentsFromNode(node).find((component) => isCameraComponent(component));
            if (!camera) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not confirm cc.Camera creation.' });
            const cameraReferenceValue = cameraReference(camera);
            if (args.is2D !== undefined) {
                const cameraIndex = cameraComponentsFromNode(node).findIndex((component) => component === camera);
                const projectionPath = `__comps__.${cameraIndex}.projection`;
                const projection = args.is2D ? 1 : 0;
                const changed = await Editor.Message.request('scene', 'set-property', { uuid: nodeReference.reference.id, path: projectionPath, dump: { value: projection, type: 'Enum' } });
                if (changed === false) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator rejected the requested camera projection.' });
            }
            await Editor.Message.request('scene', 'snapshot');
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
            const verifiedCamera = cameraComponentsFromNode(verifiedNode).find((component) => isCameraComponent(component));
            if (!verifiedCamera || cameraReference(verifiedCamera).id !== cameraReferenceValue.id) throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not confirm camera read-back.' });
            if (args.is2D !== undefined && cameraComponentField(verifiedCamera, 'projection') !== (args.is2D ? 1 : 0)) {
                throw new ToolError({ code: 'CAMERA_CREATE_UNCONFIRMED', status: 502, message: 'Creator did not retain the requested camera projection.' });
            }
            return { nodeReference: nodeReference.reference, cameraReference: cameraReferenceValue };
        } catch (error) {
            let cleanupCause: string | undefined;
            try {
                await Editor.Message.request('scene', 'remove-node', { uuid: nodeReference.reference.id });
                await Editor.Message.request('scene', 'snapshot');
            } catch (cleanupError) { cleanupCause = cleanupError instanceof Error ? cleanupError.message : String(cleanupError); }
            try {
                const remaining = await Editor.Message.request('scene', 'query-node', nodeReference.reference.id);
                if (remaining !== null && remaining !== undefined) throw new Error('Created camera node remains or cleanup response is invalid.');
            } catch (cleanupError) {
                throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: 'Camera creation failed and owned-node cleanup could not be verified.', details: { nodeUuid: nodeReference.reference.id, cause: error instanceof Error ? error.message : String(error), cleanupCause: cleanupCause ?? (cleanupError instanceof Error ? cleanupError.message : String(cleanupError)) } });
            }
            throw error;
        }
    }

    @utcpTool(
        'cameraList',
        'List cc.Camera components in the open scene with bounded node traversal and authoritative component read-back.',
        { type: 'object', properties: { maxResults: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } } },
        { type: 'object', properties: { cameras: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['cameras', 'total', 'truncated'] },
        'GET', ['scene', 'camera', 'list', 'query']
    )
    async cameraList(args: { maxResults?: number } = {}): Promise<{ cameras: Array<Record<string, unknown>>, total: number, truncated: boolean }> {
        if (args.maxResults !== undefined && (!Number.isInteger(args.maxResults) || args.maxResults < 1 || args.maxResults > MAX_LIST_LIMIT)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxResults must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        }
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open scene hierarchy.' });
        const limit = boundedListLimit(args.maxResults);
        const cameras: Array<Record<string, unknown>> = [];
        let total = 0;
        for (const row of cameraSceneNodes(tree)) {
            const nodeId = typeof row.uuid === 'string' ? row.uuid : undefined;
            if (nodeId) {
                const dump = await Editor.Message.request('scene', 'query-node', nodeId);
                for (const component of cameraComponentsFromNode(dump).filter(isCameraComponent)) {
                    total += 1;
                    if (cameras.length >= limit) continue;
                    cameras.push({
                        nodeReference: { id: nodeId, type: 'cc.Node' },
                        name: typeof row.name === 'string' ? row.name : unwrapSceneValue(row.name),
                        cameraReference: cameraReference(component),
                        priority: cameraComponentField(component, 'priority'),
                        visibility: cameraComponentField(component, 'visibility'),
                        projection: cameraComponentField(component, 'projection'),
                    });
                }
            }
        }
        return { cameras, total, truncated: total > limit };
    }

    @utcpTool(
        'cameraSetProperties',
        'Set bounded cc.Camera properties through scene IPC and verify each requested value by fresh component read-back.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, properties: { type: 'object', minProperties: 1, maxProperties: 32, propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$' } } },
            required: ['reference', 'properties'],
        },
        { type: 'object', properties: { updated: { type: 'boolean', const: true }, reference: InstanceReferenceSchema }, required: ['updated', 'reference'] },
        'POST', ['scene', 'camera', 'set', 'properties']
    )
    async cameraSetProperties(args: { reference: IInstanceReference, properties: Record<string, unknown> }): Promise<{ updated: true, reference: IInstanceReference }> {
        if (!args.reference?.id || !args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties) || Object.keys(args.properties).length === 0) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'cameraSetProperties requires a camera reference and non-empty properties.' });
        }
        const propertyNames = Object.keys(args.properties);
        if (propertyNames.length > 32 || propertyNames.some((property) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(property))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Camera properties require 1 to 32 bounded identifier names, not nested paths.' });
        }
        const nodeTree = await Editor.Message.request('scene', 'query-node-tree');
        if (!nodeTree) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No open scene hierarchy.' });
        let foundNode: Record<string, unknown> | undefined;
        let foundComponent: unknown;
        let componentIndex = -1;
        for (const row of cameraSceneNodes(nodeTree)) {
            const components = cameraComponentsFromNode(row);
            for (let index = 0; index < components.length; index++) {
                if (componentUuid(components[index]) !== args.reference.id) continue;
                if (foundNode || !isCameraComponent(components[index])) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera UUID is ambiguous in the scene hierarchy.' });
                foundNode = row;
                foundComponent = components[index];
                componentIndex = index;
            }
        }
        const nodeId = foundNode && typeof foundNode.uuid === 'string' ? foundNode.uuid : undefined;
        if (!nodeId || !foundComponent || componentIndex < 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Camera ${args.reference.id} was not found in the open scene.` });
        const serializedNode = await Editor.Message.request('scene', 'query-node', nodeId);
        const serializedComponents = cameraComponentsFromNode(serializedNode);
        const requireUniqueCamera = (components: unknown[]) => {
            let index = -1;
            for (let candidate = 0; candidate < components.length; candidate++) {
                if (componentUuid(components[candidate]) !== args.reference.id) continue;
                if (index >= 0 || !isCameraComponent(components[candidate])) throw new ToolError({ code: 'CAMERA_TARGET_AMBIGUOUS', status: 409, message: 'Camera UUID does not identify exactly one camera component.' });
                index = candidate;
            }
            return index;
        };
        componentIndex = requireUniqueCamera(serializedComponents);
        if (componentIndex < 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Camera is absent from the serialized node.' });
        const previous = new Map<string, unknown>();
        const applied: string[] = [];
        let mutationPending = false;
        const restoreApplied = async (): Promise<string | null> => {
            const failures: string[] = [];
            for (let index = applied.length - 1; index >= 0; index--) {
                const property = applied[index];
                try {
                    const currentNode = await Editor.Message.request('scene', 'query-node', nodeId);
                    const components = cameraComponentsFromNode(currentNode);
                    if (requireUniqueCamera(components) !== componentIndex) throw new Error('Camera identity/index changed before restoration.');
                    const observed = cameraComponentField(components[componentIndex], property);
                    if (JSON.stringify(observed) === JSON.stringify(previous.get(property))) continue;
                    if (JSON.stringify(observed) !== JSON.stringify(args.properties[property])) throw new Error('Camera value changed outside this update; restoration refused.');
                    await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${componentIndex}.${property}`, dump: { value: previous.get(property) as IPropertyValueType, type: typeof previous.get(property) === 'number' ? 'Number' : typeof previous.get(property) === 'boolean' ? 'Boolean' : 'String' } });
                    const restoredNode = await Editor.Message.request('scene', 'query-node', nodeId);
                    const restoredComponents = cameraComponentsFromNode(restoredNode);
                    const restoredIndex = requireUniqueCamera(restoredComponents);
                    if (JSON.stringify(cameraComponentField(restoredComponents[restoredIndex], property)) !== JSON.stringify(previous.get(property))) failures.push(property);
                } catch { failures.push(property); }
            }
            return failures.length ? failures.join(',') : null;
        };
        try {
            for (const [property, value] of Object.entries(args.properties)) {
                const currentNode = await Editor.Message.request('scene', 'query-node', nodeId);
                const currentComponents = cameraComponentsFromNode(currentNode);
                if (requireUniqueCamera(currentComponents) !== componentIndex) throw new ToolError({ code: 'CAMERA_TARGET_CHANGED', status: 409, message: 'Camera serialized component index changed before property dispatch.' });
                previous.set(property, cameraComponentField(currentComponents[componentIndex], property));
                const propertyValue = value as IPropertyValueType;
                mutationPending = true;
                const changed = await Editor.Message.request('scene', 'set-property', { uuid: nodeId, path: `__comps__.${componentIndex}.${property}`, dump: { value: propertyValue, type: typeof value === 'number' ? 'Number' : typeof value === 'boolean' ? 'Boolean' : 'String' } });
                mutationPending = false;
                applied.push(property);
                if (changed === false) throw new ToolError({ code: 'CAMERA_PROPERTY_UPDATE_FAILED', status: 502, message: `Creator rejected camera property ${property}.` });
            }
            await Editor.Message.request('scene', 'snapshot');
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeId);
            const verifiedComponents = cameraComponentsFromNode(verifiedNode);
            const verified = verifiedComponents[requireUniqueCamera(verifiedComponents)];
            if (!verified || Object.entries(args.properties).some(([property, value]) => JSON.stringify(cameraComponentField(verified, property)) !== JSON.stringify(value))) throw new ToolError({ code: 'CAMERA_PROPERTY_UPDATE_UNCONFIRMED', status: 502, message: 'Camera property mutation was not confirmed by read-back.' });
            return { updated: true, reference: cameraReference(verified) };
        } catch (error) {
            if (mutationPending) throw new ToolError({ code: 'CAMERA_MUTATION_OUTCOME_UNKNOWN', status: 502, message: 'Camera property dispatch did not return a settled outcome; automatic restoration was not attempted.', details: { nodeId, componentId: args.reference.id, applied, retrySafe: false, restored: null }, recovery: 'Inspect the exact camera and reconcile the in-flight request before another mutation.' });
            const rollbackFailure = await restoreApplied();
            throw new ToolError({ code: rollbackFailure ? 'ROLLBACK_FAILED' : 'CAMERA_PROPERTY_UPDATE_FAILED', status: 502, message: rollbackFailure ? `Camera property update failed; rollback could not verify ${rollbackFailure}.` : 'Camera property update failed; owned camera values were restored.', details: { nodeId, componentId: args.reference.id, applied, rollbackFailure, cause: error instanceof Error ? error.message : String(error) }, recovery: rollbackFailure ? 'Inspect the camera before retrying; do not replay an ambiguous mutation.' : 'Retry only after fresh camera identity/read-back.' });
        }
    }

    @utcpTool(
        'findNodesByAsset',
        'Find nodes referencing a given asset uuid. Reverse-reference / impact analysis.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum references to return.' }
            },
            required: ['reference']
        },
        { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['references', 'total', 'truncated'] }, "GET", ['scene', 'node', 'find', 'asset', 'reference', 'usage', 'impact']
    )
    async findNodesByAsset(args: { reference: IInstanceReference, limit?: number }): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
        const assetId = args.reference?.id;
        if (typeof assetId !== 'string' || !assetId.trim()) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'findNodesByAsset requires reference.id (asset uuid).' });
        }
        await assetInfoForSceneUsage(assetId);
        return queryNodesForAsset(assetId, boundedListLimit(args.limit));
    }

    @utcpTool('spriteFrameUsageInspect', 'Inspect bounded scene nodes referencing one SpriteFrame asset.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['reference'] }, { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, nodes: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['reference', 'nodes', 'total', 'truncated'] }, 'GET', ['scene', 'sprite', 'frame', 'usage', 'inspect'])
    async spriteFrameUsageInspect(args: { reference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const id = args.reference?.id;
        if (typeof id !== 'string' || !id.trim()) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'spriteFrameUsageInspect requires reference.id.' });
        const info = await assetInfoForSceneUsage(id);
        if (info.type !== 'cc.SpriteFrame' && info.importer !== 'sprite-frame') {
            throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${id} is not a SpriteFrame.` });
        }
        const result = await queryNodesForAsset(id, boundedListLimit(args.limit));
        return { reference: { id, type: 'cc.SpriteFrame' }, nodes: result.references, total: result.total, truncated: result.truncated };
    }
    @utcpTool('spriteFrameUsageBatchInspect', 'Inspect scene usage for a bounded batch of SpriteFrame assets with per-item errors.', { type: 'object', additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema }, limitPerFrame: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['references'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'sprite', 'frame', 'usage', 'batch'])
    async spriteFrameUsageBatchInspect(args: { references: IInstanceReference[], limitPerFrame?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references must contain 1 to 64 items.' });
        const limit = boundedListLimit(args.limitPerFrame);
        const items: Array<Record<string, unknown>> = [];
        for (const [index, reference] of args.references.entries()) {
            try {
                items.push({ index, ok: true, result: await this.spriteFrameUsageInspect({ reference, limit }) });
            } catch (error) {
                items.push({ index, ok: false, reference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true);
        return { items, succeeded, failed: items.length - succeeded, truncated };
    }


    @utcpTool('imageSceneUsageInspect', 'Inspect scene usage for an imported image and its bounded SpriteFrame sub-assets.', { type: 'object', additionalProperties: false, properties: { imageReference: InstanceReferenceSchema, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 }, limitPerAsset: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['imageReference'] }, { type: 'object', additionalProperties: false, properties: { imageReference: InstanceReferenceSchema, direct: { type: 'object' }, spriteFrames: { type: 'array' }, totalSpriteFrames: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['imageReference', 'direct', 'spriteFrames', 'totalSpriteFrames', 'truncated'] }, 'GET', ['scene', 'image', 'sprite', 'usage', 'inspect'])
    async imageSceneUsageInspect(args: { imageReference: IInstanceReference, maxFrames?: number, limitPerAsset?: number }): Promise<Record<string, unknown>> {
        const imageId = args.imageReference?.id;
        if (!imageId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'imageReference.id is required.' });
        const maxFrames = args.maxFrames ?? 128;
        if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxFrames must be an integer from 1 to 256.' });
        const limit = boundedListLimit(args.limitPerAsset);
        const info = await assetInfoForSceneUsage(imageId);
        if (!['image', 'texture'].includes(String(info.importer ?? '')) && !['cc.ImageAsset', 'cc.Texture2D'].includes(String(info.type ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Asset ${imageId} is not an imported image.` });
        const frames = info.subAssets && typeof info.subAssets === 'object' && !Array.isArray(info.subAssets) ? Object.values(info.subAssets) : [];
        const spriteFrames = frames.filter((frame): frame is Record<string, unknown> => !!frame && typeof frame === 'object' && ((frame as Record<string, unknown>).importer === 'sprite-frame' || (frame as Record<string, unknown>).type === 'cc.SpriteFrame'));
        const frameReferences = spriteFrames.slice(0, maxFrames).map((frame) => {
            if (typeof frame.uuid !== 'string' || !frame.uuid.trim()) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `Creator returned a SpriteFrame without an asset identity for ${imageId}.` });
            return { id: frame.uuid, type: 'cc.SpriteFrame' };
        });
        const direct = await queryNodesForAsset(imageId, limit);
        const frameUsages = [];
        for (const reference of frameReferences) frameUsages.push(await this.spriteFrameUsageInspect({ reference, limit }));
        return { imageReference: { id: imageId, type: typeof info.type === 'string' ? info.type : 'cc.ImageAsset' }, direct: { nodes: direct.references, total: direct.total, truncated: direct.truncated }, spriteFrames: frameUsages, totalSpriteFrames: spriteFrames.length, truncated: direct.truncated || spriteFrames.length > maxFrames || frameUsages.some((entry) => entry.truncated === true) };
    }
    @utcpTool('imageSceneUsageBatchInspect', 'Inspect scene usage for a bounded batch of imported image assets with per-item errors.', { type: 'object', additionalProperties: false, properties: { imageReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, maxFrames: { type: 'integer', minimum: 1, maximum: 256, default: 128 }, limitPerAsset: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['imageReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'image', 'sprite', 'usage', 'batch'])
    async imageSceneUsageBatchInspect(args: { imageReferences: IInstanceReference[], maxFrames?: number, limitPerAsset?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.imageReferences) || args.imageReferences.length < 1 || args.imageReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'imageReferences must contain 1 to 32 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, imageReference] of args.imageReferences.entries()) {
            try { items.push({ index, ok: true, result: await this.imageSceneUsageInspect({ imageReference, maxFrames: args.maxFrames, limitPerAsset: args.limitPerAsset }) }); }
            catch (error) { items.push({ index, ok: false, imageReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } }); }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true) };
    }

    @utcpTool(
        'findNodesWithMissingAssets',
        'Find nodes with missing/broken asset references. QA/health check for scene integrity.',
        {
            type: 'object',
            properties: {
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum references to return.' }
            }
        },
        { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['references', 'total', 'truncated'] }, "GET", ['scene', 'node', 'missing', 'broken', 'asset', 'qa', 'health', 'integrity']
    )
    async findNodesWithMissingAssets(args: { limit?: number } = {}): Promise<{ references: IInstanceReference[], total: number, truncated: boolean }> {
        const result: unknown = await Editor.Message.request('scene', 'query-nodes-miss-assets');
        if (!Array.isArray(result)) {
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned no missing-assets node list.' });
        }
        const limit = boundedListLimit(args.limit);
        const references: IInstanceReference[] = [];
        for (const [index, value] of result.entries()) {
            const id = nodeUuidFromSceneUsage(value, 'query-nodes-miss-assets');
            if (index < limit) references.push({ id, type: 'cc.Node' });
        }
        return { references, total: result.length, truncated: result.length > limit };
    }

    @utcpTool(
        'findNodes',
        'Find nodes by name and/or component type. In-memory walk of query-node-tree; substring match on name, exact match on component class.',
        {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Substring match on node name (case-insensitive).' },
                componentType: { type: 'string', description: 'Exact component class, e.g. cc.Sprite, cc.Label.' },
                maxResults: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Cap results.' }
            },
            anyOf: [
                { required: ['name'] },
                { required: ['componentType'] }
            ],
        },
        { type: 'object', properties: { nodes: { type: 'array', items: { type: 'object', properties: { reference: InstanceReferenceSchema, name: { type: 'string' }, path: { type: 'string' } } } }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['nodes', 'total'] }, "GET", ['scene', 'node', 'find', 'search', 'name', 'component', 'filter']
    )
    async findNodes(args: { name?: string, componentType?: string, maxResults?: number }): Promise<{ nodes: Array<{ reference: IInstanceReference, name: string, path: string }>, total: number, truncated: boolean }> {
        if (!args.name && !args.componentType) throw new Error('findNodes requires at least one of name or componentType');
        let treeBase: any = await Editor.Message.request('scene', 'query-node-tree');
        if (!treeBase) throw new Error('Scene is empty or could not retrieve scene tree.');
        treeBase = (await this.findPrefabEditRoot(treeBase)) ?? treeBase;
        const nameNeedle = args.name ? args.name.toLowerCase() : null;
        const compNeedle = args.componentType || null;
        const limit = boundedListLimit(args.maxResults);
        const hits: Array<{ reference: IInstanceReference, name: string, path: string }> = [];
        let total = 0;
        const stack: Array<{ node: any, path: string }> = [{ node: treeBase, path: treeBase.name || '' }];
        while (stack.length) {
            const { node, path: curPath } = stack.pop()!;
            const nodeName: string = node.name || '';
            const comps: any[] = node.components || [];
            const nameOk = !nameNeedle || nodeName.toLowerCase().includes(nameNeedle);
            // docs §1 bug class, second site: the dump's component type is inconsistent
            // and user scripts may carry it as __type__/cid. Match with the same tolerance
            // nodeComponentsGet uses rather than a bare equality.
            const compOk = !compNeedle || comps.some((c: any) => {
                const declared: string | undefined = c?.type ?? c?.__type__ ?? c?.cid;
                if (!declared) return false;
                return declared === compNeedle || declared === `cc.${compNeedle}` || declared.replace(/^cc\./, '') === compNeedle.replace(/^cc\./, '');
            });
            if (nameOk && compOk) {
                total++;
                if (hits.length < limit) hits.push({ reference: { id: node.uuid, type: 'cc.Node' }, name: nodeName, path: curPath });
            }
            const children: any[] = node.children || [];
            for (let i = children.length - 1; i >= 0; i--) {
                const ch = children[i];
                const childPath = curPath ? `${curPath}/${ch.name || ''}` : (ch.name || '');
                stack.push({ node: ch, path: childPath });
            }
        }
        return { nodes: hits, total, truncated: total > limit };
    }

    @utcpTool(
        'nodeGetPath',
        'Resolve a node UUID to its stable hierarchy path in the open scene or prefab. Use this reverse lookup before generating getChildByPath/find calls.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                relativeTo: InstanceReferenceSchema,
                includeRoot: { type: 'boolean', default: true },
            },
            required: ['reference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                path: { type: 'string' },
                segments: { type: 'array', items: { type: 'string' } },
                relativeTo: InstanceReferenceSchema,
            },
            required: ['reference', 'path', 'segments'],
        },
        'GET',
        ['scene', 'node', 'path', 'hierarchy', 'reverse', 'lookup']
    )
    async nodeGetPath(args: { reference: IInstanceReference, relativeTo?: IInstanceReference, includeRoot?: boolean }): Promise<{ reference: IInstanceReference, path: string, segments: string[], relativeTo?: IInstanceReference }> {
        const tree = await Editor.Message.request('scene', 'query-node-tree') as unknown as SceneTreeNode | null;
        if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy' });
        const root = args.relativeTo?.id
            ? findSceneTreeNode(tree, args.relativeTo.id)
            : ((await this.findPrefabEditRoot(tree)) as unknown as SceneTreeNode | null) ?? tree;
        if (!root) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `Relative root ${args.relativeTo?.id} not found` });

        const stack: Array<{ node: SceneTreeNode, segments: string[] }> = [{ node: root, segments: [sceneTreeNodeName(root)] }];
        while (stack.length) {
            const current = stack.pop()!;
            if (current.node.uuid === args.reference.id) {
                const segments = args.includeRoot === false ? current.segments.slice(1) : current.segments;
                return {
                    reference: { id: args.reference.id, type: 'cc.Node' },
                    path: segments.join('/'),
                    segments,
                    ...(args.relativeTo ? { relativeTo: args.relativeTo } : {}),
                };
            }
            const children = current.node.children ?? [];
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                stack.push({ node: child, segments: [...current.segments, sceneTreeNodeName(child)] });
            }
        }
        throw new ToolError({ code: 'NOT_FOUND', status: 404, message: `Node ${args.reference.id} is not inside the requested hierarchy` });
    }

    @utcpTool(
        'sceneHierarchyValidate',
        'Validate scene hierarchy identity, unique paths, and parent-child topology within bounded traversal.',
        {
            type: 'object',
            properties: {
                rootReference: InstanceReferenceSchema,
                limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: MAX_LIST_LIMIT }
            }
        },
        {
            type: 'object',
            properties: {
                valid: { type: 'boolean' },
                checkedNodes: { type: 'integer' },
                issues: { type: 'array', items: { type: 'string' } },
                truncated: { type: 'boolean' }
            },
            required: ['valid', 'checkedNodes', 'issues', 'truncated']
        },
        'GET',
        ['scene', 'hierarchy', 'validate', 'parent', 'path', 'integrity']
    )
    async sceneHierarchyValidate(args: { rootReference?: IInstanceReference, limit?: number } = {}): Promise<{ valid: boolean, checkedNodes: number, issues: string[], truncated: boolean }> {
        const tree = await Editor.Message.request('scene', 'query-node-tree') as any;
        if (!tree) throw new Error('sceneHierarchyValidate: no open scene or failed to query scene tree');
        let root = tree;
        if (args.rootReference?.id) {
            const candidates = [tree];
            root = undefined;
            while (candidates.length) {
                const candidate = candidates.pop();
                if (candidate?.uuid === args.rootReference.id) {
                    root = candidate;
                    break;
                }
                if (Array.isArray(candidate?.children)) candidates.push(...candidate.children);
            }
            if (!root) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Hierarchy root ${args.rootReference.id} not found`, recovery: 'Query the current scene tree and retry with an existing node id.' });
        }
        const limit = boundedListLimit(args.limit);
        const issues: string[] = [];
        const seenObjects = new Set<object>();
        const seenUuids = new Map<string, string>();
        const parentByUuid = new Map<string, string>();
        const stack: Array<{ node: any, path: string, parentPath: string }> = [{ node: root, path: root.name || '', parentPath: '' }];
        let checkedNodes = 0;
        let truncated = false;
        while (stack.length) {
            if (checkedNodes >= limit) {
                truncated = true;
                break;
            }
            const current = stack.pop()!;
            const node = current.node;
            if (!node || typeof node !== 'object') {
                issues.push(`invalid node at ${current.path || '(root)'}`);
                continue;
            }
            if (seenObjects.has(node)) {
                issues.push(`cycle or repeated node object at ${current.path || '(root)'}`);
                continue;
            }
            seenObjects.add(node);
            checkedNodes++;
            const path = current.path || '(root)';
            const uuid = typeof node.uuid === 'string' ? node.uuid : '';
            if (!uuid) {
                issues.push(`missing uuid at ${path}`);
            } else {
                const firstPath = seenUuids.get(uuid);
                if (firstPath) {
                    issues.push(`duplicate uuid ${uuid} at ${path}; first seen at ${firstPath}`);
                    const firstParent = parentByUuid.get(uuid);
                    if (firstParent !== undefined && firstParent !== current.parentPath) {
                        issues.push(`invalid parenting for ${uuid}: ${firstParent} and ${current.parentPath || '(root)'}`);
                    }
                } else {
                    seenUuids.set(uuid, path);
                    parentByUuid.set(uuid, current.parentPath);
                }
            }
            const childPaths = new Set<string>();
            const children = Array.isArray(node.children) ? node.children : [];
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                const childName = typeof child?.name === 'string' ? child.name : '';
                const childPath = path === '(root)' ? childName || `(child-${index})` : `${path}/${childName || `(child-${index})`}`;
                if (childPaths.has(childPath)) issues.push(`duplicate path ${childPath}`);
                childPaths.add(childPath);
                stack.push({ node: child, path: childPath, parentPath: path });
            }
        }
        return {
            valid: issues.length === 0 && !truncated,
            checkedNodes,
            issues: issues.slice(0, MAX_LIST_LIMIT),
            truncated
        };
    }

    @utcpTool(
        'sceneScriptHealthScan',
        'Scan the open scene or prefab for script components whose class is no longer registered. Read-only; returns node paths and repair candidates.',
        {
            type: 'object',
            properties: {
                limit: { type: 'number', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT }
            }
        },
        {
            type: 'object',
            properties: {
                findings: { type: 'array', items: { type: 'object' } },
                total: { type: 'number' },
                truncated: { type: 'boolean' }
            },
            required: ['findings', 'total', 'truncated']
        },
        'GET',
        ['scene', 'script', 'missing', 'invalid', 'scan', 'health', 'repair']
    )
    async sceneScriptHealthScan(args: { limit?: number } = {}): Promise<{ findings: Array<Record<string, unknown>>, total: number, truncated: boolean }> {
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new Error('sceneScriptHealthScan: no open scene or prefab');
        const componentTypes = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(componentTypes)) throw new Error('sceneScriptHealthScan: failed to query registered component types');
        const registered = new Set(componentTypes.flatMap((candidate: unknown) => componentCandidates(candidate)));
        const findings: Array<Record<string, unknown>> = [];
        const rootName = typeof tree.name === 'string'
            ? tree.name
            : (tree.name && typeof tree.name.value === 'string' ? tree.name.value : '');
        const stack: Array<{ node: any, path: string }> = [{ node: (await this.findPrefabEditRoot(tree)) ?? tree, path: rootName }];
        while (stack.length) {
            const { node, path: nodePath } = stack.pop()!;
            const components = node.components || node.__comps__ || [];
            for (const component of components) {
                const classId = componentClassId(component);
                const uuid = componentUuid(component);
                if (!classId || registered.has(classId) || classId.startsWith('cc.')) continue;
                findings.push({
                    nodeReference: { id: node.uuid, type: 'cc.Node' },
                    nodeName: node.name || '',
                    nodePath,
                    componentReference: uuid ? { id: uuid, type: 'cc.Component' } : undefined,
                    classId,
                    repair: 'Provide scriptReference or replacementClassId to sceneScriptRepair'
                });
            }
            for (const child of [...(node.children || [])].reverse()) {
                stack.push({ node: child, path: nodePath ? `${nodePath}/${child.name || ''}` : child.name || '' });
            }
        }
        const limit = boundedListLimit(args.limit);
        return { findings: findings.slice(0, limit), total: findings.length, truncated: findings.length > limit };
    }

    @utcpTool('sceneScriptHealthBatchScan', 'Scan bounded scene roots for missing custom script classes with per-root outcomes.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, limitPerRoot: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['nodeReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'script', 'health', 'batch', 'scan'])
    async sceneScriptHealthBatchScan(args: { nodeReferences: IInstanceReference[], limitPerRoot?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 32 items.' });
        const limit = boundedListLimit(args.limitPerRoot);
        const componentTypes = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(componentTypes)) throw new ToolError({ code: 'SCRIPT_HEALTH_QUERY_FAILED', status: 502, message: 'Creator did not return registered component types.' });
        const registered = new Set(componentTypes.flatMap((candidate: unknown) => componentCandidates(candidate)));
        const items: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                const tree = await Editor.Message.request('scene', 'query-node-tree', nodeReference.id) as any;
                if (!tree) throw new Error(`Node ${nodeReference.id} was not found.`);
                const findings: Array<Record<string, unknown>> = [];
                const stack: Array<{ node: any, path: string }> = [{ node: tree, path: typeof tree.name === 'string' ? tree.name : '' }];
                while (stack.length) {
                    const { node, path: nodePath } = stack.pop()!;
                    for (const component of node.components || node.__comps__ || []) {
                        const classId = componentClassId(component);
                        if (!classId || classId.startsWith('cc.') || registered.has(classId)) continue;
                        findings.push({ nodeReference: { id: node.uuid, type: 'cc.Node' }, nodePath, componentReference: componentUuid(component) ? { id: componentUuid(component)!, type: 'cc.Component' } : null, classId });
                    }
                    for (const child of [...(node.children || [])].reverse()) stack.push({ node: child, path: nodePath ? `${nodePath}/${child.name || ''}` : child.name || '' });
                }
                items.push({ index, ok: true, nodeReference, findings: findings.slice(0, limit), total: findings.length, truncated: findings.length > limit });
            } catch (error) {
                items.push({ index, ok: false, nodeReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: items.some((item) => item.truncated === true) };
    }

    @utcpTool('sceneScriptUsageInspect', 'Inspect bounded script component usage across the open scene with optional class filtering.', { type: 'object', additionalProperties: false, properties: { classId: { type: 'string', maxLength: 256 }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: [] }, { type: 'object', additionalProperties: false, properties: { usages: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['usages', 'total', 'truncated'] }, 'GET', ['scene', 'script', 'usage', 'inspect'])
    async sceneScriptUsageInspect(args: { classId?: string, limit?: number } = {}): Promise<Record<string, unknown>> {
        if (args.classId !== undefined && (typeof args.classId !== 'string' || !args.classId || args.classId.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'classId must be a bounded non-empty string.' });
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limit);
        const tree = await Editor.Message.request('scene', 'query-node-tree');
        if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy.' });
        const usages: Array<Record<string, unknown>> = [];
        const stack: Array<{ node: any, path: string }> = [{ node: tree, path: typeof tree.name === 'string' ? tree.name : '' }];
        const visited = new Set<object>();
        let scheduled = 1;
        let total = 0;
        while (stack.length) {
            const { node, path: nodePath } = stack.pop()!;
            if (!node || typeof node !== 'object' || visited.has(node)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage hierarchy contains an invalid or repeated node.' });
            visited.add(node);
            const components = node.components ?? node.__comps__ ?? [];
            if (!Array.isArray(components)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage components must be an array.' });
            for (const component of components) {
                if (!component || typeof component !== 'object' || Array.isArray(component)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage contains an invalid component entry.' });
                const classId = componentClassId(component);
                const componentId = componentUuid(component);
                if (!classId || classId.startsWith('cc.') || (args.classId && classId !== args.classId)) continue;
                total++;
                if (usages.length < limit) usages.push({ nodeReference: { id: node.uuid, type: 'cc.Node' }, nodePath, componentReference: componentId ? { id: componentId, type: classId } : null, classId });
            }
            const children = node.children ?? [];
            if (!Array.isArray(children)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Script usage hierarchy children must be an array.' });
            scheduled += children.length;
            if (scheduled > VERBOSE_TREE_NODES) throw new ToolError({ code: 'LIMIT_EXCEEDED', status: 413, message: 'Script usage hierarchy exceeds the 10000-node traversal budget.' });
            for (let index = children.length - 1; index >= 0; index--) {
                const child = children[index];
                stack.push({ node: child, path: nodePath ? `${nodePath}/${child?.name || ''}` : child?.name || '' });
            }
        }
        return { usages, total, truncated: total > usages.length };
    }

    @utcpTool('scriptAssetSceneUsageInspect', 'Resolve an imported script class and inspect its bounded usage across the open scene.', { type: 'object', additionalProperties: false, properties: { scriptReference: InstanceReferenceSchema, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['scriptReference'] }, { type: 'object', additionalProperties: false, properties: { scriptReference: InstanceReferenceSchema, classId: { type: 'string' }, usages: { type: 'array' }, total: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['scriptReference', 'classId', 'usages', 'total', 'truncated'] }, 'GET', ['scene', 'script', 'asset', 'usage', 'inspect'])
    async scriptAssetSceneUsageInspect(args: { scriptReference: IInstanceReference, limit?: number }): Promise<Record<string, unknown>> {
        const scriptId = args.scriptReference?.id;
        if (typeof scriptId !== 'string' || !scriptId.trim() || scriptId.length > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReference.id must be a bounded non-empty string.' });
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const asset = await assetInfoForSceneUsage(scriptId);
        if (asset.isDirectory === true || !['typescript', 'javascript'].includes(String(asset.importer ?? ''))) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Script usage lookup requires an imported TypeScript or JavaScript asset.' });
        let classId: unknown;
        try { classId = await Editor.Message.request('scene', 'query-script-cid', scriptId); }
        catch { throw new ToolError({ code: 'SCRIPT_METADATA_QUERY_FAILED', status: 502, message: 'Creator could not query the script class identity.' }); }
        if (typeof classId !== 'string' || !classId) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: `Creator did not expose a class ID for script ${scriptId}.` });
        const usage = await this.sceneScriptUsageInspect({ classId, limit: args.limit });
        const current = await assetInfoForSceneUsage(scriptId);
        let currentClassId: unknown;
        try { currentClassId = await Editor.Message.request('scene', 'query-script-cid', scriptId); }
        catch { throw new ToolError({ code: 'SCRIPT_METADATA_QUERY_FAILED', status: 502, message: 'Creator could not recheck the script class identity.' }); }
        if (currentClassId !== classId || current.url !== asset.url || current.file !== asset.file || current.importer !== asset.importer || current.type !== asset.type || current.isDirectory !== asset.isDirectory) throw new ToolError({ code: 'SCRIPT_ASSET_CHANGED', status: 409, message: 'Script asset identity or class binding changed during usage inspection; no mixed result returned.' });
        return { scriptReference: { id: scriptId, type: typeof asset.type === 'string' && asset.type ? asset.type : 'cc.Script' }, classId, usages: usage.usages, total: usage.total, truncated: usage.truncated };
    }
    @utcpTool('scriptAssetSceneUsageBatchInspect', 'Inspect bounded scene usage for multiple imported script assets with per-script errors.', { type: 'object', additionalProperties: false, properties: { scriptReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, limitPerScript: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT } }, required: ['scriptReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, partial: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated', 'partial'] }, 'GET', ['scene', 'script', 'asset', 'usage', 'batch', 'inspect'])
    async scriptAssetSceneUsageBatchInspect(args: { scriptReferences: IInstanceReference[], limitPerScript?: number }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.scriptReferences) || args.scriptReferences.length < 1 || args.scriptReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReferences must contain 1 to 32 items.' });
        if (args.limitPerScript !== undefined && (!Number.isInteger(args.limitPerScript) || args.limitPerScript < 1 || args.limitPerScript > MAX_LIST_LIMIT)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `limitPerScript must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        const limit = boundedListLimit(args.limitPerScript);
        const items: Array<Record<string, unknown>> = [];
        for (const [index, scriptReference] of args.scriptReferences.entries()) {
            try {
                items.push({ index, ok: true, scriptReference, result: await this.scriptAssetSceneUsageInspect({ scriptReference, limit }) });
            } catch (error) {
                items.push({ index, ok: false, scriptReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_USAGE_INSPECTION_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        const truncated = items.some((item) => item.ok === true && (item.result as Record<string, unknown>)?.truncated === true);
        return { items, succeeded, failed: items.length - succeeded, truncated, partial: succeeded > 0 && succeeded < items.length };
    }


    @utcpTool('sceneScriptUsageSummary', 'Summarize custom script usage from bounded inspection. countsComplete=false means per-class counts and totalClasses are lower bounds; node-detail truncation is separate.', { type: 'object', additionalProperties: false, properties: { maxClasses: { type: 'integer', minimum: 1, maximum: 256, default: 64 }, maxNodesPerClass: { type: 'integer', minimum: 1, maximum: 256, default: 32 } }, required: [] }, { type: 'object', additionalProperties: false, properties: { classes: { type: 'array' }, totalClasses: { type: 'integer' }, totalUsages: { type: 'integer' }, countsComplete: { type: 'boolean' }, truncated: { type: 'boolean' } }, required: ['classes', 'totalClasses', 'totalUsages', 'countsComplete', 'truncated'] }, 'GET', ['scene', 'script', 'usage', 'summary'])
    async sceneScriptUsageSummary(args: { maxClasses?: number, maxNodesPerClass?: number } = {}): Promise<Record<string, unknown>> {
        const maxClasses = args.maxClasses ?? 64;
        const maxNodesPerClass = args.maxNodesPerClass ?? 32;
        if (!Number.isInteger(maxClasses) || maxClasses < 1 || maxClasses > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxClasses must be an integer from 1 to 256.' });
        if (!Number.isInteger(maxNodesPerClass) || maxNodesPerClass < 1 || maxNodesPerClass > 256) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxNodesPerClass must be an integer from 1 to 256.' });
        const usage = await this.sceneScriptUsageInspect({ limit: MAX_LIST_LIMIT });
        const groups = new Map<string, Array<Record<string, unknown>>>();
        for (const row of usage.usages as Array<Record<string, unknown>>) {
            const classId = row.classId;
            if (typeof classId !== 'string') continue;
            const group = groups.get(classId) ?? [];
            group.push(row);
            groups.set(classId, group);
        }
        const all = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
        const countsComplete = usage.truncated === false;
        const classes = all.slice(0, maxClasses).map(([classId, rows]) => ({ classId, count: rows.length, nodes: rows.slice(0, maxNodesPerClass).map((row) => ({ nodeReference: row.nodeReference, nodePath: row.nodePath, componentReference: row.componentReference })), truncated: !countsComplete || rows.length > maxNodesPerClass }));
        return { classes, totalClasses: all.length, totalUsages: usage.total, countsComplete, truncated: !countsComplete || all.length > classes.length || classes.some((entry) => entry.truncated) };
    }

    @utcpTool('sceneScriptComponentInspect', 'Inspect one custom scene script component with class identity and authoritative serialized dump.', { type: 'object', additionalProperties: false, properties: { componentReference: InstanceReferenceSchema }, required: ['componentReference'] }, { type: 'object', additionalProperties: false, properties: { componentReference: InstanceReferenceSchema, classId: { type: 'string' }, dump: { type: 'object' } }, required: ['componentReference', 'classId', 'dump'] }, 'GET', ['scene', 'script', 'component', 'inspect'])
    async sceneScriptComponentInspect(args: { componentReference: IInstanceReference }): Promise<Record<string, unknown>> {
        const componentId = args.componentReference?.id;
        if (!componentId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptComponentInspect requires componentReference.id.' });
        const dump = await Editor.Message.request('scene', 'query-component', componentId) as any;
        if (!dump || typeof dump !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Script component ${componentId} was not found.` });
        if (Array.isArray(dump) || componentUuid(dump) !== componentId) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned mismatched or missing script component identity.' });
        const classId = componentClassId(dump);
        if (!classId || classId.startsWith('cc.')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Component ${componentId} is not a custom script component.` });
        return { componentReference: { id: componentId, type: classId }, classId, dump };
    }

    @utcpTool('sceneScriptComponentBatchInspect', 'Inspect a bounded batch of custom scene script components with per-item errors.', { type: 'object', additionalProperties: false, properties: { componentReferences: { type: 'array', minItems: 1, maxItems: 64, items: InstanceReferenceSchema } }, required: ['componentReferences'] }, { type: 'object', additionalProperties: false, properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['items', 'succeeded', 'failed', 'truncated'] }, 'GET', ['scene', 'script', 'component', 'batch', 'inspect'])
    async sceneScriptComponentBatchInspect(args: { componentReferences: IInstanceReference[] }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.componentReferences) || args.componentReferences.length < 1 || args.componentReferences.length > 64) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentReferences must contain 1 to 64 items.' });
        const items: Array<Record<string, unknown>> = [];
        for (const [index, componentReference] of args.componentReferences.entries()) {
            try {
                items.push({ index, ok: true, result: await this.sceneScriptComponentInspect({ componentReference }) });
            } catch (error) {
                items.push({ index, ok: false, componentReference, error: { message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) } });
            }
        }
        const succeeded = items.filter((item) => item.ok === true).length;
        return { items, succeeded, failed: items.length - succeeded, truncated: false };
    }

    @utcpTool(
        'sceneScriptRepair',
        'Replace one missing or invalid script component after verifying the target and replacement class. Uses editor undo snapshot and verifies the new component.',
        {
            type: 'object',
            properties: {
                nodeReference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                expectedClassId: { type: 'string' },
                replacementClassId: { type: 'string' },
                scriptReference: InstanceReferenceSchema
            },
            required: ['nodeReference'],
            anyOf: [
                { required: ['componentReference'] },
                { required: ['expectedClassId'] }
            ],
            oneOf: [
                { required: ['replacementClassId'] },
                { required: ['scriptReference'] }
            ]
        },
        {
            type: 'object',
            properties: { success: { type: 'boolean' }, removedComponent: { type: 'string' }, createdComponent: InstanceReferenceSchema },
            required: ['success', 'createdComponent']
        },
        'POST',
        ['scene', 'script', 'missing', 'invalid', 'repair', 'replace', 'component']
    )
    async sceneScriptRepair(args: { nodeReference: IInstanceReference, componentReference?: IInstanceReference, expectedClassId?: string, replacementClassId?: string, scriptReference?: IInstanceReference }): Promise<{ success: boolean, removedComponent?: string, createdComponent: IInstanceReference }> {
        const nodeUuid = args.nodeReference?.id;
        if (!nodeUuid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptRepair requires nodeReference.id' });
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeUuid} was not found.` });
        if (!Array.isArray(node.__comps__)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a complete component inventory for repair preflight.' });
        const components = node.__comps__;
        const targets = components.filter((component: unknown) => args.componentReference?.id ? componentUuid(component) === args.componentReference.id : args.expectedClassId && componentClassId(component) === args.expectedClassId);
        if (targets.length > 1) throw new ToolError({ code: 'SCRIPT_TARGET_AMBIGUOUS', status: 409, message: 'Repair selector matches multiple components; provide an exact component UUID.' });
        const target = targets[0];
        const oldUuid = componentUuid(target);
        if (!target || !oldUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'sceneScriptRepair target component was not found.' });
        const originalClass = componentClassId(target);
        if (args.expectedClassId !== undefined && originalClass !== args.expectedClassId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Repair component no longer matches expectedClassId.' });
        const replacement = args.scriptReference?.id ? await Editor.Message.request('scene', 'query-script-cid', args.scriptReference.id) : args.replacementClassId;
        if (typeof replacement !== 'string' || !replacement) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: 'Replacement script class is missing or invalid.' });
        const available = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(available) || !findComponentType(available, replacement)) throw new ToolError({ code: 'SCRIPT_NOT_REGISTERED', status: 422, message: `Replacement class '${replacement}' is not registered in Creator.` });
        const fresh = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        const freshTargets = Array.isArray(fresh?.__comps__) ? fresh.__comps__.filter((component: unknown) => componentUuid(component) === oldUuid) : [];
        if (freshTargets.length !== 1 || componentClassId(freshTargets[0]) !== originalClass) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Repair target identity changed during preflight; no removal was dispatched.' });
        let createdUuid: string | undefined;
        let phase: 'remove-dispatch' | 'remove-readback' | 'create-dispatch' | 'create-readback' | 'snapshot' = 'remove-dispatch';
        let removalConfirmed = false;
        try {
            await Editor.Message.request('scene', 'remove-component', { uuid: oldUuid });
            phase = 'remove-readback';
            const removed = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            if (!removed || !Array.isArray(removed.__comps__) || removed.__comps__.some((component: unknown) => componentUuid(component) === oldUuid)) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Original component removal was not confirmed; replacement was not dispatched.' });
            const priorIds = new Set(removed.__comps__.map((component: unknown) => componentUuid(component)));
            removalConfirmed = true;
            phase = 'create-dispatch';
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: replacement });
            phase = 'create-readback';
            const after = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            if (!after || !Array.isArray(after.__comps__) || after.__comps__.some((component: unknown) => componentUuid(component) === oldUuid)) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Repair component inventory is incomplete or original component is present.' });
            const candidates = after.__comps__.filter((component: unknown) => componentClassId(component) === replacement && componentUuid(component) && !priorIds.has(componentUuid(component)));
            if (candidates.length !== 1) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Creator did not expose exactly one new replacement component.' });
            createdUuid = componentUuid(candidates[0]);
            if (!createdUuid) throw new ToolError({ code: 'SCRIPT_REPAIR_UNCONFIRMED', status: 502, message: 'Replacement component identity is unavailable.' });
            phase = 'snapshot';
            await Editor.Message.request('scene', 'snapshot');
            return { success: true, removedComponent: oldUuid, createdComponent: { id: createdUuid, type: replacement } };
        } catch (error) {
            throw new ToolError({ code: phase === 'remove-dispatch' || phase === 'create-dispatch' ? 'SCRIPT_REPAIR_OUTCOME_UNKNOWN' : 'SCRIPT_REPAIR_PARTIAL', status: 502, message: 'Script repair did not complete; inspect the node before retrying.', details: { nodeUuid, targetComponent: oldUuid, removedComponent: removalConfirmed ? oldUuid : null, removalConfirmed, phase, replacement, createdComponent: createdUuid ?? null, retrySafe: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect current components; do not blindly repeat remove/create after an ambiguous mutation.' });
        }
    }
    @utcpTool('sceneScriptRepairBatch', 'Repair bounded missing script components with per-item replacement verification.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, expectedClassId: { type: 'string', maxLength: 256 }, replacementClassId: { type: 'string', maxLength: 256 }, scriptReference: InstanceReferenceSchema }, required: ['nodeReference'] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'repair'])
    async sceneScriptRepairBatch(args: { items: Array<{ nodeReference: IInstanceReference, componentReference?: IInstanceReference, expectedClassId?: string, replacementClassId?: string, scriptReference?: IInstanceReference }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 repair requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try { outcomes.push({ index, ok: true, result: await this.sceneScriptRepair(item) }); }
            catch (error) { outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_REPAIR_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } }); }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }
    @utcpTool(
        'sceneScriptAttach',
        'Attach one registered project script to a scene node with typed preflight and authoritative read-back.',
        { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, scriptReference: InstanceReferenceSchema }, required: ['nodeReference', 'scriptReference'] },
        { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', const: true }, nodeReference: InstanceReferenceSchema, scriptReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema }, required: ['success', 'nodeReference', 'scriptReference', 'componentReference'] },
        'POST', ['scene', 'script', 'attach', 'component']
    )
    async sceneScriptAttach(args: { nodeReference: IInstanceReference, scriptReference: IInstanceReference }): Promise<{ success: true, nodeReference: IInstanceReference, scriptReference: IInstanceReference, componentReference: IInstanceReference }> {
        const nodeUuid = args.nodeReference?.id;
        const scriptUuid = args.scriptReference?.id;
        if (!nodeUuid || !scriptUuid) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptAttach requires nodeReference.id and scriptReference.id.' });
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeUuid} was not found.` });
        const classId = await Editor.Message.request('scene', 'query-script-cid', scriptUuid);
        if (typeof classId !== 'string' || !classId) throw new ToolError({ code: 'SCRIPT_METADATA_UNAVAILABLE', status: 422, message: `Creator did not expose a class ID for script ${scriptUuid}.` });
        const available = await Editor.Message.request('scene', 'query-components');
        if (!Array.isArray(available) || !findComponentType(available, classId)) throw new ToolError({ code: 'SCRIPT_NOT_REGISTERED', status: 422, message: `Script class '${classId}' is not registered in Creator.` });
        if ((node.__comps__ || []).some((component: unknown) => componentClassId(component) === classId)) throw new ToolError({ code: 'SCRIPT_ALREADY_ATTACHED', status: 409, message: `Script class '${classId}' is already attached to node ${nodeUuid}.` });
        const existingIds = new Set((node.__comps__ || []).map((component: unknown) => componentUuid(component)));
        let createdUuid: string | undefined;
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: classId });
            const after = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
            const candidates = (after?.__comps__ || []).filter((component: unknown) => componentClassId(component) === classId);
            const created = candidates.length === 1 ? candidates[0] : undefined;
            createdUuid = componentUuid(created);
            if (createdUuid && existingIds.has(createdUuid)) createdUuid = undefined;
            if (!created || !createdUuid) throw new ToolError({ code: 'SCRIPT_ATTACH_UNCONFIRMED', status: 502, message: `Creator did not return the attached script component for node ${nodeUuid}.` });
            await Editor.Message.request('scene', 'snapshot');
            return { success: true, nodeReference: { id: nodeUuid, type: args.nodeReference.type ?? 'cc.Node' }, scriptReference: { id: scriptUuid, type: args.scriptReference.type ?? 'cc.Script' }, componentReference: { id: createdUuid, type: classId } };
        } catch (error) {
            if (!createdUuid) throw new ToolError({ code: 'SCRIPT_ATTACH_OUTCOME_UNKNOWN', status: 502, message: 'Script attachment was dispatched but its component identity was not confirmed; no cleanup was attempted.', details: { nodeUuid, scriptUuid, classId, retrySafe: false, restored: null }, recovery: 'Inspect current node components before another attachment; never replay the create blindly.' });
            let rollbackFailure: string | undefined;
            if (createdUuid) {
                try {
                    const current = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
                    if (!current || !Array.isArray(current.__comps__) || current.__comps__.filter((component: unknown) => componentUuid(component) === createdUuid && componentClassId(component) === classId).length !== 1) throw new Error('Owned component identity changed before cleanup.');
                    await Editor.Message.request('scene', 'remove-component', { uuid: createdUuid });
                    const rollbackNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as any;
                    if (!rollbackNode || !Array.isArray(rollbackNode.__comps__) || rollbackNode.__comps__.some((component: unknown) => componentUuid(component) === createdUuid)) rollbackFailure = `Created component ${createdUuid} absence was not confirmed.`;
                } catch (rollbackError) { rollbackFailure = rollbackError instanceof Error ? rollbackError.message : String(rollbackError); }
            }
            throw new ToolError({ code: rollbackFailure ? 'ROLLBACK_FAILED' : (error instanceof ToolError ? error.code : 'SCRIPT_ATTACH_FAILED'), status: 502, message: rollbackFailure ? `Script attachment failed and cleanup could not be verified.` : `Script attachment failed; owned component cleanup was verified.`, details: { nodeUuid, scriptUuid, classId, createdUuid: createdUuid ?? null, rollbackFailure, cause: error instanceof Error ? error.message : String(error) }, recovery: rollbackFailure ? 'Inspect the node and remove the owned component manually before retrying.' : 'Rescan the node before retrying; no ambiguous component remains.' });
        }
    }
    @utcpTool('sceneScriptBatchAttach', 'Attach one registered script to a bounded set of scene nodes with per-item read-back outcomes.', { type: 'object', additionalProperties: false, properties: { nodeReferences: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema }, scriptReference: InstanceReferenceSchema }, required: ['nodeReferences', 'scriptReference'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'attach'])
    async sceneScriptBatchAttach(args: { nodeReferences: IInstanceReference[], scriptReference: IInstanceReference }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.nodeReferences) || args.nodeReferences.length < 1 || args.nodeReferences.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReferences must contain 1 to 32 items.' });
        if (!args.scriptReference?.id) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scriptReference.id is required.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, nodeReference] of args.nodeReferences.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.sceneScriptAttach({ nodeReference, scriptReference: args.scriptReference }) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_ATTACH_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }

    @utcpTool('sceneScriptDetach', 'Detach one script component from a scene node with preflight, absence read-back, and undo snapshot.', { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, scriptClassId: { type: 'string' } }, required: ['nodeReference'], anyOf: [{ required: ['componentReference'] }, { required: ['scriptClassId'] }] }, { type: 'object', additionalProperties: false, properties: { success: { type: 'boolean', const: true }, nodeReference: InstanceReferenceSchema, removedComponent: InstanceReferenceSchema }, required: ['success', 'nodeReference', 'removedComponent'] }, 'POST', ['scene', 'script', 'detach', 'component'])
    async sceneScriptDetach(args: { nodeReference: IInstanceReference, componentReference?: IInstanceReference, scriptClassId?: string }): Promise<{ success: true, nodeReference: IInstanceReference, removedComponent: IInstanceReference }> {
        const nodeId = args.nodeReference?.id;
        if (!nodeId) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'sceneScriptDetach requires nodeReference.id.' });
        const node = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${nodeId} was not found.` });
        if (!Array.isArray(node.__comps__)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator did not return a complete component inventory for detach preflight.' });
        const targets = node.__comps__.filter((component: unknown) => {
            const uuid = componentUuid(component);
            const classId = componentClassId(component);
            return (args.componentReference?.id && uuid === args.componentReference.id) || (!args.componentReference?.id && args.scriptClassId && classId === args.scriptClassId);
        });
        if (targets.length > 1) throw new ToolError({ code: 'SCRIPT_TARGET_AMBIGUOUS', status: 409, message: 'Detach selector matches multiple components; provide an exact component UUID.' });
        const target = targets[0];
        const componentId = componentUuid(target);
        const classId = componentClassId(target);
        if (!target || !componentId || !classId) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Script component was not found on node ${nodeId}.` });
        if (args.scriptClassId !== undefined && args.scriptClassId !== classId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Detach target no longer matches scriptClassId.' });
        const fresh = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        const freshTargets = Array.isArray(fresh?.__comps__) ? fresh.__comps__.filter((component: unknown) => componentUuid(component) === componentId) : [];
        if (freshTargets.length !== 1 || componentClassId(freshTargets[0]) !== classId) throw new ToolError({ code: 'SCRIPT_TARGET_CHANGED', status: 409, message: 'Detach target identity changed during preflight; no removal was dispatched.' });
        await Editor.Message.request('scene', 'remove-component', { uuid: componentId });
        const after = await Editor.Message.request('scene', 'query-node', nodeId) as any;
        if (!after || !Array.isArray(after.__comps__) || after.__comps__.some((component: unknown) => componentUuid(component) === componentId)) throw new ToolError({ code: 'SCRIPT_DETACH_UNCONFIRMED', status: 502, message: `Creator did not confirm removal of script component ${componentId}.`, details: { nodeId, componentId, retrySafe: false }, recovery: 'Inspect the node before another removal; missing or malformed node data is not component absence proof.' });
        await Editor.Message.request('scene', 'snapshot');
        return { success: true, nodeReference: { id: nodeId, type: args.nodeReference.type ?? 'cc.Node' }, removedComponent: { id: componentId, type: classId } };
    }
    @utcpTool('sceneScriptBatchDetach', 'Detach bounded script components from scene nodes with per-item absence read-back outcomes.', { type: 'object', additionalProperties: false, properties: { items: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, properties: { nodeReference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, scriptClassId: { type: 'string', maxLength: 256 } }, required: ['nodeReference'], anyOf: [{ required: ['componentReference'] }, { required: ['scriptClassId'] }] } } }, required: ['items'] }, { type: 'object', additionalProperties: false, properties: { outcomes: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, partial: { type: 'boolean' } }, required: ['outcomes', 'succeeded', 'failed', 'partial'] }, 'POST', ['scene', 'script', 'batch', 'detach'])
    async sceneScriptBatchDetach(args: { items: Array<{ nodeReference: IInstanceReference, componentReference?: IInstanceReference, scriptClassId?: string }> }): Promise<Record<string, unknown>> {
        if (!Array.isArray(args?.items) || args.items.length < 1 || args.items.length > 32) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'items must contain 1 to 32 detach requests.' });
        const outcomes: Array<Record<string, unknown>> = [];
        for (const [index, item] of args.items.entries()) {
            try {
                outcomes.push({ index, ok: true, result: await this.sceneScriptDetach(item) });
            } catch (error) {
                outcomes.push({ index, ok: false, nodeReference: item?.nodeReference, error: { code: error instanceof ToolError ? error.code : 'SCRIPT_DETACH_FAILED', message: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512), recovery: error instanceof ToolError ? error.recovery?.slice(0, 512) : undefined, retrySafe: false } });
            }
        }
        const succeeded = outcomes.filter((outcome) => outcome.ok === true).length;
        return { outcomes, succeeded, failed: outcomes.length - succeeded, partial: succeeded > 0 && succeeded < outcomes.length };
    }



    @utcpTool(
        'nodeReset',
        'Reset node or component properties to defaults. Operations: "node" (all), "component" (one component), "property" (one field by path).',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['node', 'component', 'property'] },
                references: { type: 'array', items: InstanceReferenceSchema, description: 'For node/component: node/component uuids. For property: exactly one node-or-component uuid.' },
                propertyPath: { type: 'string', description: 'For property only: inspector path (e.g. "position", "__comps__.0.type").' }
            },
            required: ['operation', 'references']
        },
        SuccessIndicatorSchema, "POST", ['scene', 'node', 'component', 'reset', 'default', 'revert', 'property']
    )
    async nodeReset(args: { operation: string, references: IInstanceReference[], propertyPath?: string }): Promise<ISuccessIndicator> {
        const uuids = (args.references || []).map((r: IInstanceReference) => r.id).filter((id: string) => !!id);
        if (uuids.length === 0) {
            throw new Error('nodeReset requires non-empty references');
        }

        if (args.operation === 'property') {
            if (uuids.length !== 1) {
                throw new Error('nodeReset operation "property" requires exactly one uuid');
            }
            if (!args.propertyPath || !args.propertyPath.trim()) {
                throw new Error('nodeReset operation "property" requires propertyPath');
            }
            // Typed facade reuses SetPropertyOptions (which marks `dump` required), but
            // reset-property ignores dump: only uuid + path matter. Cast to satisfy tsc.
            const ok = await Editor.Message.request('scene', 'reset-property', { uuid: uuids[0], path: args.propertyPath } as any);
            if (!ok) {
                throw new Error(`Failed to reset property ${args.propertyPath} on ${uuids[0]}`);
            }
        } else if (args.operation === 'node') {
            const ok = await Editor.Message.request('scene', 'reset-node', { uuid: uuids.length === 1 ? uuids[0] : uuids });
            if (!ok) {
                throw new Error(`Failed to reset nodes ${uuids.join(', ')}`);
            }
        } else if (args.operation === 'component') {
            if (uuids.length !== 1) {
                throw new Error('nodeReset operation "component" requires exactly one component uuid');
            }
            await Editor.Message.request('scene', 'reset-component', { uuid: uuids[0] });
        } else {
            throw new Error(`Unknown reset operation: ${args.operation}`);
        }

        await Editor.Message.request('scene', 'snapshot');
        return { success: true };
    }

    @utcpTool(
        'callComponentMethod',
        'Call a method on a component by uuid. Args and return must be JSON-serializable. Get uuid via nodeComponentsGet.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                methodName: { type: 'string', description: 'Name of the method to call' },
                methodArgs: { type: 'array', items: {}, description: 'Arguments to pass to the method (JSON-serializable)' }
            },
            required: ['reference', 'methodName']
        },
        { type: 'object', properties: { result: {} } }, "POST", ['scene', 'component', 'call', 'execute', 'method', 'invoke', 'script']
    )
    async callComponentMethod(args: { reference: IInstanceReference, methodName: string, methodArgs?: any[] }): Promise<{ result: any }> {
        if (!args.reference || !args.reference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'callComponentMethod requires reference.id (component uuid)' });
        }
        if (typeof args.methodName !== 'string' || !ALLOWED_COMPONENT_METHODS[args.methodName]) {
            throw new ToolError({ code: 'METHOD_NOT_ALLOWED', status: 422, message: `Component method '${String(args.methodName)}' is not in the bounded allowlist.` });
        }
        const methodArgs = args.methodArgs ?? [];
        if (!Array.isArray(methodArgs) || methodArgs.length > MAX_COMPONENT_METHOD_ARGS) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `methodArgs must contain at most ${MAX_COMPONENT_METHOD_ARGS} JSON values.` });
        }
        let encodedArgs: string;
        try { encodedArgs = JSON.stringify(methodArgs); } catch (error) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'methodArgs must be JSON-serializable.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        if (Buffer.byteLength(encodedArgs, 'utf8') > MAX_COMPONENT_METHOD_BYTES) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `methodArgs must be at most ${MAX_COMPONENT_METHOD_BYTES} UTF-8 bytes.` });
        }
        const component = await Editor.Message.request('scene', 'query-component', args.reference.id);
        if (!component || typeof component !== 'object') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Component ${args.reference.id} was not found.` });
        const result = await Editor.Message.request('scene', 'execute-component-method', { uuid: args.reference.id, name: args.methodName, args: methodArgs });
        await Editor.Message.request('scene', 'snapshot');
        let normalizedResult: unknown = result === undefined ? null : result;
        try {
            const encodedResult = JSON.stringify(normalizedResult);
            if (Buffer.byteLength(encodedResult, 'utf8') > MAX_COMPONENT_METHOD_RESULT_BYTES) {
                throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 502, message: `Component method result exceeds ${MAX_COMPONENT_METHOD_RESULT_BYTES} UTF-8 bytes.` });
            }
            normalizedResult = JSON.parse(encodedResult);
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component method result was not JSON-serializable.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        return { result: normalizedResult };
    }

    @utcpTool(
        'listComponentMethods',
        'List discovered method names per component, separately reporting the finite callComponentMethod allowlist. Discovery does not authorize arbitrary or lifecycle execution.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema
            },
            required: ['reference']
        },
        {
            type: 'object',
            properties: {
                components: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            reference: InstanceReferenceSchema,
                            methods: { type: 'array', items: { type: 'string' } },
                            permittedMethods: { type: 'array', items: { type: 'string' } },
                            deniedMethods: { type: 'array', items: { type: 'string' } },
                            permissionReason: { type: 'string' }
                        }
                    }
                }
            },
            required: ['components']
        }, "GET", ['scene', 'node', 'component', 'method', 'function', 'list', 'discover', 'callable', 'invoke', 'script']
    )
    async listComponentMethods(args: { reference: IInstanceReference }): Promise<{ components: Array<{ reference: IInstanceReference, methods: string[], permittedMethods: string[], deniedMethods: string[], permissionReason: string }> }> {
        if (!args.reference || !args.reference.id) {
            throw new Error('listComponentMethods requires reference.id (node uuid)');
        }
        const queriedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (queriedNode == null) {
            throw new ToolError({
                code: 'TARGET_NOT_FOUND',
                status: 404,
                message: `Node not found: ${args.reference.id}`,
                details: { requestedId: args.reference.id },
                recovery: 'Call nodeGetTree or sceneGetInfo to inspect the active scene and use a current node reference.',
            });
        }
        const raw = await Editor.Message.request('scene', 'query-component-function-of-node', args.reference.id);
        if (raw === null || raw === undefined) {
            throw new Error(`listComponentMethods: query-component-function-of-node returned no payload for ${args.reference.id}`);
        }

        const objectField = (value: unknown, key: string): unknown => value && typeof value === 'object' && !Array.isArray(value) ? Reflect.get(value, key) : undefined;
        const toMethods = (value: unknown): string[] => {
            const source = Array.isArray(value) ? value : objectField(value, 'functions') ?? objectField(value, 'methods');
            if (!Array.isArray(source)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Creator returned an invalid component method collection.' });
            return source.map(item => typeof item === 'string' ? item : objectField(item, 'name') ?? objectField(item, 'functionName')).filter((name): name is string => typeof name === 'string' && name.length > 0);
        };
        const dumps: unknown = objectField(queriedNode, '__comps__');
        if (!Array.isArray(dumps)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Node dump omitted authoritative component identities.' });
        const identities = dumps.map(dump => ({ id: componentUuid(dump), type: typeof objectField(dump, 'type') === 'string' ? String(objectField(dump, 'type')) : componentClassId(dump), classId: componentClassId(dump) }));
        if (identities.some(identity => !identity.id || !identity.type)) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Component identity/type is incomplete.' });
        const entries: Array<{ selector: string; value: unknown }> = Array.isArray(raw)
            ? raw.map(entry => ({ selector: String(objectField(entry, 'uuid') ?? objectField(entry, 'id') ?? objectField(entry, 'type') ?? ''), value: entry }))
            : raw && typeof raw === 'object' ? Object.entries(raw).map(([selector, value]) => ({ selector, value })) : [];
        const components: Array<{ reference: IInstanceReference; methods: string[] }> = [];
        for (const entry of entries) {
            const matched = identities.filter(identity => identity.id === entry.selector || identity.type === entry.selector || identity.classId === entry.selector);
            if (!matched.length) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: 'Discovered method class does not map to an attached component.' });
            const methods = toMethods(entry.value);
            for (const identity of matched) components.push({ reference: { id: identity.id!, type: identity.type! }, methods });
        }

        return { components: components.map(component => ({ ...component, permittedMethods: component.methods.filter(name => Object.prototype.hasOwnProperty.call(ALLOWED_COMPONENT_METHODS, name)), deniedMethods: component.methods.filter(name => !Object.prototype.hasOwnProperty.call(ALLOWED_COMPONENT_METHODS, name)), permissionReason: 'Only the existing finite invocation allowlist is permitted; discovered names do not grant execution rights.' })) };
    }

    @utcpTool(
        'listComponentClasses',
        'List editor classes, filter by base class e.g. cc.Component.',
        {
            type: 'object',
            properties: {
                extends: { type: 'string', description: 'Base class name to filter by, e.g. cc.Component' },
                excludeSelf: { type: 'boolean', description: 'Exclude the base class itself from results', default: false },
                filter: { type: 'string', description: 'Case-insensitive substring match on class name' }
            }
        },
        { type: 'object', properties: { classes: { type: 'array', items: { type: 'string' } } }, required: ['classes'] }, "GET", ['scene', 'class', 'component', 'list', 'types', 'script']
    )
    async listComponentClasses(args: { extends?: string, excludeSelf?: boolean, filter?: string }): Promise<{ classes: string[] }> {
        const options: { extends?: string, excludeSelf?: boolean } = {
            extends: args.extends || 'cc.Component',
        };
        if (args.excludeSelf) {
            options.excludeSelf = true;
        }
        const classes = await Editor.Message.request('scene', 'query-classes', options);
        if (!Array.isArray(classes)) {
            throw new Error('Failed to query classes');
        }
        const lowerFilter = args.filter ? args.filter.toLowerCase() : null;
        const names = classes
            .map((c: any) => (c && c.name) as string)
            .filter((name: any) => typeof name === 'string' && (!lowerFilter || name.toLowerCase().includes(lowerFilter)));
        return { classes: names };
    }

    @utcpTool(
        'nodeClipboard',
        'Copy/cut/paste nodes via editor clipboard. Paste returns references of pasted nodes.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['copy', 'cut', 'paste'] },
                references: { type: 'array', items: InstanceReferenceSchema, description: 'For copy/cut: the nodes to copy/cut. For paste: the copied node references to paste.' },
                targetReference: InstanceReferenceSchema,
                keepWorldTransform: { type: 'boolean', description: 'For paste: keep world transform of pasted nodes', default: true },
                pasteAsChild: { type: 'boolean', description: 'For paste: paste as child of the target node', default: false }
            },
            required: ['operation', 'references']
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                references: { type: 'array', items: InstanceReferenceSchema }
            },
            required: ['success']
        }, "POST", ['scene', 'node', 'copy', 'cut', 'paste', 'clipboard']
    )
    async nodeClipboard(args: { operation: string, references: IInstanceReference[], targetReference?: IInstanceReference, keepWorldTransform?: boolean, pasteAsChild?: boolean }):
        Promise<{ success: boolean, references?: IInstanceReference[] }> {
        const uuids = (args.references || []).map((r: IInstanceReference) => r.id).filter((id: string) => !!id);
        if (uuids.length === 0) {
            throw new Error('nodeClipboard requires non-empty references');
        }

        switch (args.operation) {
            case 'copy': {
                const copied = await Editor.Message.request('scene', 'copy-node', uuids);
                if (!Array.isArray(copied)) {
                    throw new Error(`Copy failed for nodes ${uuids.join(', ')}`);
                }
                return { success: true, references: copied.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            case 'cut': {
                await Editor.Message.request('scene', 'cut-node', uuids);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true, references: uuids.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            case 'paste': {
                if (!args.targetReference || !args.targetReference.id) {
                    throw new Error('targetReference required for paste');
                }
                const pasted = await Editor.Message.request('scene', 'paste-node', {
                    target: args.targetReference.id,
                    uuids: uuids,
                    keepWorldTransform: args.keepWorldTransform ?? true,
                    pasteAsChild: args.pasteAsChild ?? false
                });
                if (!Array.isArray(pasted) || pasted.length === 0) {
                    throw new Error('Paste returned no nodes');
                }
                await Editor.Message.request('scene', 'snapshot');
                return { success: true, references: pasted.map((id: string) => ({ id, type: 'cc.Node' })) };
            }
            default:
                throw new Error(`Unknown clipboard operation: ${args.operation}`);
        }
    }
    @utcpTool(
        'nodeGetTree',
        'Get node hierarchy tree. Defaults maxDepth=4/maxNodes=200; verbose=true raises caps to depth 99/nodes 10000. Supports fields filter and bounded root-child pagination with a hierarchy revision token.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                maxDepth: { type: 'number', minimum: 0, maximum: VERBOSE_TREE_DEPTH, default: DEFAULT_TREE_MAX_DEPTH, description: 'Max recursion depth. 0 = root only, 1 = root + direct children.' },
                maxNodes: { type: 'number', minimum: 1, maximum: VERBOSE_TREE_NODES, default: DEFAULT_TREE_MAX_NODES, description: 'Max descendant nodes to walk; guards wide scenes where maxDepth alone does not bound.' },
                verbose: { type: 'boolean', description: 'When true, raises omitted caps to depth 99/nodes 10000.' },
                fields: { type: 'array', items: { type: 'string' }, description: 'Optional: only keep these node keys per node (e.g. ["name","active","components"]). reference+children always kept. Omit for all fields.' },
                childOffset: { type: 'integer', minimum: 0, maximum: MAX_TREE_CHILD_OFFSET, default: 0, description: 'Zero-based window offset among the requested root node children.' },
                pageSize: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT, default: DEFAULT_LIST_LIMIT, description: 'Maximum root children in this window. Descendant depth/node budgets still apply.' },
                expectedRevision: { type: 'string', minLength: 1, maxLength: 128, description: 'Optional hierarchy revision token from an earlier page; changed topology is rejected with 409.' }
            }
        },
        SceneTreeItemSchema, 'GET', ['scene', 'graph', 'node', 'hierarchy', 'tree']
    )
    async nodeGetTree(args: { reference?: IInstanceReference, maxDepth?: number, maxNodes?: number, verbose?: boolean, fields?: string[], childOffset?: number, pageSize?: number, expectedRevision?: string }): Promise<ISceneTreeItem> {
        if (args.reference?.id && args.reference.id.includes('#')) {
            const [file, uuid] = args.reference.id.split('#');
            throw new ToolError({
                code: 'COMPOSITE_HANDLE_NOT_SUPPORTED',
                status: 400,
                message: `Composite graph handle "${args.reference.id}" passed to live tool nodeGetTree. Pass bare engine UUID only.`,
                details: { file, uuid, reference: args.reference },
                recovery: `Node belongs to "${file}". Check if this file is currently open via sceneGetInfo. If it is a prefab, inspect offline via readPrefabJson or cocos-graph navigate. Otherwise pass bare uuid "${uuid}".`
            });
        }

        const maxDepth = args.maxDepth === undefined
            ? (args.verbose ? VERBOSE_TREE_DEPTH : DEFAULT_TREE_MAX_DEPTH)
            : args.maxDepth;
        const maxNodes = args.maxNodes === undefined
            ? (args.verbose ? VERBOSE_TREE_NODES : DEFAULT_TREE_MAX_NODES)
            : args.maxNodes;
        if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > VERBOSE_TREE_DEPTH) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxDepth must be an integer from 0 to ${VERBOSE_TREE_DEPTH}.` });
        }
        if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > VERBOSE_TREE_NODES) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `maxNodes must be an integer from 1 to ${VERBOSE_TREE_NODES}.` });
        }
        const childOffset = args.childOffset === undefined ? 0 : args.childOffset;
        const pageSize = args.pageSize === undefined ? DEFAULT_LIST_LIMIT : args.pageSize;
        if (!Number.isInteger(childOffset) || childOffset < 0 || childOffset > MAX_TREE_CHILD_OFFSET) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `childOffset must be an integer from 0 to ${MAX_TREE_CHILD_OFFSET}.` });
        }
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_LIST_LIMIT) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `pageSize must be an integer from 1 to ${MAX_LIST_LIMIT}.` });
        }
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !args.expectedRevision || args.expectedRevision.length > 128)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision must be a non-empty revision token.' });
        }

        let treeBase: unknown;
        if (args.reference) {
            treeBase = await Editor.Message.request('scene', 'query-node-tree', args.reference.id);
        } else {
            treeBase = await Editor.Message.request('scene', 'query-node-tree');
            treeBase = (await this.findPrefabEditRoot(treeBase)) ?? treeBase;
        }

        if (!treeBase || typeof treeBase !== 'object' || Array.isArray(treeBase)) {
            const currentRaw = (await Editor.Message.request('scene', 'query-current-scene').catch(() => undefined)) as unknown;
            let currentSceneUuid = 'unknown';
            if (typeof currentRaw === 'string') currentSceneUuid = currentRaw;
            else if (currentRaw && typeof currentRaw === 'object' && typeof (currentRaw as Record<string, unknown>).uuid === 'string') currentSceneUuid = (currentRaw as Record<string, unknown>).uuid as string;
            const isRootQuery = !args.reference?.id;
            throw new ToolError({
                code: 'TARGET_NOT_FOUND', status: 404,
                message: isRootQuery ? 'Node tree not found: no active scene or prefab is currently open in the editor.' : `Node tree not found for node "${args.reference?.id}" in the currently open scene.`,
                details: { requestedId: args.reference?.id ?? null, currentSceneUuid },
                recovery: isRootQuery ? "Open a scene first using sceneOpen({ assetPath: 'db://assets/.../scene_name.scene' })." : 'Refresh the active scene and retry with a current node reference.'
            });
        }

        const root = treeBase as Record<string, unknown>;
        const rawChildren = Array.isArray(root.children) ? root.children : [];
        if (childOffset > rawChildren.length) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `childOffset ${childOffset} is outside the root child range 0-${rawChildren.length}.`, details: { childOffset, childrenCount: rawChildren.length } });
        }
        const topology = (node: unknown): unknown => {
            if (!node || typeof node !== 'object' || Array.isArray(node)) return { id: null, children: [] };
            const value = node as Record<string, unknown>;
            const children = Array.isArray(value.children) ? value.children : [];
            return { id: typeof value.uuid === 'string' ? value.uuid : null, children: children.map(topology) };
        };
        const currentRaw = (await Editor.Message.request('scene', 'query-current-scene').catch(() => undefined)) as unknown;
        const sceneUuid = typeof currentRaw === 'string' ? currentRaw : currentRaw && typeof currentRaw === 'object' && typeof (currentRaw as Record<string, unknown>).uuid === 'string' ? (currentRaw as Record<string, unknown>).uuid as string : '';
        const revision = createHash('sha256').update(JSON.stringify({ sceneUuid, root: topology(root) })).digest('hex');
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) {
            throw new ToolError({ code: 'HIERARCHY_REVISION_CONFLICT', status: 409, message: 'Scene hierarchy changed since the requested revision; page was not returned.', details: { expectedRevision: args.expectedRevision, actualRevision: revision, reference: args.reference ?? null } });
        }

        const budget = { left: maxNodes };
        const fieldSet = args.fields && args.fields.length > 0 ? new Set(args.fields) : null;
        const want = (key: string) => !fieldSet || fieldSet.has(key);
        const formatNode = (nodeValue: unknown, depth: number): ISceneTreeItem => {
            const node = nodeValue as Record<string, unknown>;
            const atMaxDepth = depth >= maxDepth;
            const descendants = Array.isArray(node.children) ? node.children : [];
            const children: ISceneTreeItem[] = [];
            let truncated: 'maxDepth' | 'nodeLimit' | undefined;
            let childrenOmitted: number | undefined;
            if (atMaxDepth && descendants.length > 0) {
                truncated = 'maxDepth';
                childrenOmitted = descendants.length;
            } else if (!atMaxDepth) {
                for (let index = 0; index < descendants.length; index += 1) {
                    if (budget.left <= 0) { truncated = 'nodeLimit'; childrenOmitted = descendants.length - index; break; }
                    budget.left -= 1;
                    children.push(formatNode(descendants[index], depth + 1));
                }
            }
            const item: ISceneTreeItem = {
                reference: { id: typeof node.uuid === 'string' ? node.uuid : '', type: 'cc.Node' },
                children,
            };
            if (want('name') && (typeof node.name === 'string' || (node.name && typeof node.name === 'object'))) item.name = typeof node.name === 'string' ? node.name : String((node.name as Record<string, unknown>).value ?? '');
            if (want('active') && typeof node.active === 'boolean') item.active = node.active;
            if (want('components')) {
                const components = Array.isArray(node.components) ? node.components : [];
                item.components = components.map((component: unknown) => {
                    const row = component && typeof component === 'object' ? component as Record<string, unknown> : {};
                    const id = componentUuid(component);
                    const type = componentClassId(component);
                    if (!id || !type) throw new ToolError({ code: 'INVALID_RESPONSE', status: 502, message: `nodeGetTree received a component without authoritative uuid/type on node ${typeof node.uuid === 'string' ? node.uuid : 'unknown'}.`, details: { nodeUuid: node.uuid ?? null, component: row }, recovery: 'Refresh the scene and retry; inspect the raw Creator node dump for schema drift.' });
                    return { id, type };
                });
            }
            if (want('path') && typeof node.path === 'string') item.path = node.path;
            if (truncated) item.truncated = truncated;
            if (childrenOmitted !== undefined) item.childrenOmitted = childrenOmitted;
            return item;
        };

        const pageEnd = Math.min(rawChildren.length, childOffset + pageSize);
        const selectedChildren = rawChildren.slice(childOffset, pageEnd);
        const rootForFormatting: Record<string, unknown> = { ...root, children: selectedChildren };
        const result = formatNode(rootForFormatting, 0);
        result.childrenCount = rawChildren.length;
        result.childOffset = childOffset;
        result.pageSize = pageSize;
        result.nextOffset = pageEnd < rawChildren.length ? pageEnd : null;
        result.revision = revision;
        return result;
    }

    @utcpTool(
        'nodeGetAtPath',
        'Get nodes at hierarchy path.',
        {
            type: 'object',
            properties: {
                hierarchyPath: { type: 'string', description: 'Path to the node in the scene hierarchy"' },
            },
            required: ['hierarchyPath']
        }, { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema } }, required: ['references'] }, "GET",  ['scene', 'node', 'get', 'path', 'find', 'look', 'instance', 'hierarchy']
    )
    async nodeGetAtPath(args: { hierarchyPath: string }): Promise<{ references: IInstanceReference[] }> {
        const nodeTree = await Editor.Message.request('scene', 'query-node-tree');
        if (!nodeTree) {
            throw new Error(`Scene is empty or could not retrieve scene tree.`);
        }

        const sceneRootName = (nodeTree.name as unknown as string);
        if (args.hierarchyPath.startsWith('/')) {
            args.hierarchyPath = args.hierarchyPath.slice(1);
        }
        if (args.hierarchyPath.startsWith(`${sceneRootName}`)) {
            args.hierarchyPath = args.hierarchyPath.slice(sceneRootName.length);
        }
        if (args.hierarchyPath === '') {
            return { references: [{ id: (nodeTree.uuid as unknown as string) }] };
        }

        const pathParts = args.hierarchyPath.split('/').filter(p => p.length > 0);
        let currentNodes = [nodeTree];
        for (const part of pathParts) {
            const nextNodes: any[] = [];
            for (const node of currentNodes) {
                const matchingChildren = (node.children || []).filter((child: any) => child.name === part);
                nextNodes.push(...matchingChildren);
            }
            currentNodes = nextNodes;
            if (currentNodes.length === 0) {
                break;
            }
        }

        return { references: currentNodes.map((node: any) => ({ id: node.uuid, type: 'cc.Node' })) };
    }

    @utcpTool(
        'nodeCreatePrimitive',
        'Create primitive node (Capsule/Cube/Sphere etc.) under parent.',
         {  type: 'object',
            properties: {
                name: { type: 'string' },
                primitiveType: { type: 'string', enum: [
                    'Capsule', 'Cone', 'Cube', 'Cylinder', 'Plane', 'Quad', 'Sphere', 'Torus',
                ] },
                parentReference: InstanceReferenceSchema
            },
            required: ['name', 'primitiveType']
         }, 
         { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, "POST",  ['scene', 'node', 'create', 'add']
    )
    async sceneCreatePrimitiveNode(args: { name: string, primitiveType: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference }> {
        const primitiveMap: Record<string, string> = {
            'Capsule': "db://internal/default_prefab/3d/Capsule.prefab",
            'Cone': "db://internal/default_prefab/3d/Cone.prefab",
            'Cube': "db://internal/default_prefab/3d/Cube.prefab",
            'Cylinder': "db://internal/default_prefab/3d/Cylinder.prefab",
            'Plane': "db://internal/default_prefab/3d/Plane.prefab",
            'Quad': "db://internal/default_prefab/3d/Quad.prefab",
            'Sphere': "db://internal/default_prefab/3d/Sphere.prefab",
            'Torus': "db://internal/default_prefab/3d/Torus.prefab",
        };

        if (!primitiveMap[args.primitiveType]) {
            throw new Error(`Unsupported primitive type: ${args.primitiveType}`);
        }

        const prefabUrl = primitiveMap[args.primitiveType];
        const assetUuid = await Editor.Message.request('asset-db', 'query-uuid', prefabUrl);
        if (!assetUuid) {
            throw new Error(`Failed to find asset for primitive type ${args.primitiveType} at ${prefabUrl}`);
        }
        return await this.sceneCreateNode({
            name: args.name,
            parentReference: args.parentReference,
            assetReference: { id: assetUuid, type: 'cc.Prefab' },
            unwrapPrefab: true
        });
    }

    @utcpTool(
        'nodeCreate',
        'Create a new node in the scene. If no parent is specified, root node is used. Returns reference to the new node.',
        {
            type: 'object',
            properties: {
                name: { type: 'string' },
                parentReference: InstanceReferenceSchema,
                assetReference: InstanceReferenceSchema,
                unwrapPrefab: { type: 'boolean', default: false }
            },
            required: ['name']
        },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, "POST",  ['scene', 'node', 'create', 'add']
    )
    async sceneCreateNode(args: { name: string, parentReference?: IInstanceReference, assetReference?: IInstanceReference, unwrapPrefab?: boolean }): Promise<{ reference: IInstanceReference }> {
        const options: any = {
            name: args.name
        };
        if (args.parentReference) {
            options.parent = args.parentReference.id;
        } else {
            // Force root if no parent provided
            options.parent = (await Editor.Message.request('scene', 'query-node-tree')).uuid;
        }

        let assetUuid: string | null = null;

        // 1. Determine Asset UUID
        if ((args.assetReference && 'id' in args.assetReference)) {
            const assetInfo = await Editor.Message.request('asset-db', 'query-asset-info', args.assetReference.id);
            if (!assetInfo) {
                throw new Error(`Asset reference not found: ${args.assetReference.id}`);
            }

            let prefabFound = assetInfo.type === 'cc.Prefab';
            // If not a prefab, check if it has a prefab sub-asset (like in case of FBX)
            if (!prefabFound) {
                for (let subAsset of Object.values(assetInfo.subAssets)) {
                    if (subAsset.type === 'cc.Prefab') {
                        assetUuid = subAsset.uuid;
                        prefabFound = true;
                        break;
                    }
                }
            } else {
                assetUuid = assetInfo.uuid;
            }

            if (!prefabFound) {
                throw new Error(`Provided asset reference ${args.assetReference.id} is not a prefab and does not contain a prefab sub-asset.`);
            } else {
                if (!args.unwrapPrefab) {
                    options.unlinkPrefab = false;
                    options.type = 'cc.Prefab';
                }
            }
        }

        if (assetUuid) {
            options.assetUuid = assetUuid;
        }

        // 2. Create Node
        const result = await Editor.Message.request('scene', 'create-node', options);
        const newNodeUuid = Array.isArray(result) ? result[0] : result;

        if (typeof newNodeUuid !== 'string' || !newNodeUuid) {
            throw new ToolError({ code: 'NODE_CREATE_UNCONFIRMED', status: 502, message: `Creator did not return a UUID for node ${args.name}.` });
        }

        await Editor.Message.request('scene', 'snapshot');
        const readBack = await Editor.Message.request('scene', 'query-node', newNodeUuid);
        const readBackUuid = typeof readBack?.uuid === 'string' ? readBack.uuid : readBack?.uuid?.value;
        if (!readBack || readBackUuid !== newNodeUuid) {
            throw new ToolError({
                code: 'NODE_CREATE_UNCONFIRMED',
                status: 502,
                message: `Creator did not confirm creation of node ${newNodeUuid}.`,
                details: { requestedName: args.name, nodeUuid: newNodeUuid },
                recovery: 'Query nodeGetTree and retry after the editor finishes the scene operation.',
            });
        }

        return { reference: { id: newNodeUuid, type: 'cc.Node' } };
    }

    @utcpTool(
        'nodeOperate',
        'Node operations: hierarchy locking, prefab link/unlink/create/save. Lock prevents edit/select in scene view.',
        {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['move', 'copy', 'delete', 'lock', 'unlock', 'create_prefab', 'link_prefab', 'revert_prefab', 'apply_prefab', 'unwrap_prefab', 'unwrap_prefab_completely', 'open_prefab'] },
                reference: InstanceReferenceSchema,
                newParentReference: InstanceReferenceSchema,
                newPrefabPath: { type: 'string', description: 'For create_prefab: target db:// path', nullable: true },
                prefabAssetReference: InstanceReferenceSchema,
                siblingIndex: { type: 'integer', description: 'For move/copy: target index in parent children array', nullable: true },
                recursive: { type: 'boolean', description: 'For lock/unlock: also apply to all descendants', default: false }
            },
            required: ['operation', 'reference']
        },
        { type: 'object',
            properties: {
                success: { type: 'boolean' },
                createdPrefabAssetReference: InstanceReferenceSchema,
                updatedNodeReference: InstanceReferenceSchema,
                copiedNodeReference: InstanceReferenceSchema
            }
        }, "POST",  ['scene', 'node', 'remove', 'move', 'copy', 'delete', 'lock', 'unlock', 'prefab', 'apply', 'revert', 'unwrap', 'create', 'link', 'bind']
    )
    async nodeOperate(args: { operation: string, reference: IInstanceReference, newParentReference?: IInstanceReference, newPrefabPath?: string, prefabAssetReference?: IInstanceReference, siblingIndex?: number, recursive?: boolean }): Promise<{ success?: boolean, createdPrefabAssetReference?: IInstanceReference, updatedNodeReference?: IInstanceReference, copiedNodeReference?: IInstanceReference }> {
        if (await Editor.Message.request('scene', 'query-node', args.reference.id) === null) {
            throw new Error(`Target node ${args.reference.id} not found`);
        }

        switch (args.operation) {
            case 'move':
                if (!args.newParentReference) {
                    throw new Error("newParentReference required for move");
                }

                await Editor.Message.request('scene', 'set-parent', {
                    parent: args.newParentReference.id,
                    uuids: args.reference.id,
                    keepWorldTransform: true
                });

                if (args.siblingIndex !== undefined) {
                    await this.setSiblingIndex(args.reference.id, args.siblingIndex);
                }

                await Editor.Message.request('scene', 'snapshot');
                const movedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
                const movedParent = movedNode?.parent?.value?.uuid ?? movedNode?.parent?.uuid;
                if (!movedNode || movedParent !== args.newParentReference.id) {
                    throw new ToolError({
                        code: 'NODE_MOVE_UNCONFIRMED', status: 502,
                        message: `Creator did not confirm node ${args.reference.id} under parent ${args.newParentReference.id}.`,
                        details: { nodeId: args.reference.id, requestedParentId: args.newParentReference.id, actualParentId: movedParent ?? null },
                    });
                }
                return { success: true };

            case 'copy':
                 const duplicateResult = await Editor.Message.request('scene', 'duplicate-node', [args.reference.id]);
                 if (!duplicateResult || duplicateResult.length === 0) {
                    throw new Error(`Node ${args.reference.id} duplication failed`);
                 }
                 
                 const newNodes = duplicateResult as string[];
                 const newNodeId = newNodes[0]; 
                 
                 if (args.newParentReference) {
                     await Editor.Message.request('scene', 'set-parent', {
                        parent: args.newParentReference.id,
                        uuids: newNodes,
                        keepWorldTransform: true
                     });
                 }

                 if (args.siblingIndex !== undefined) {
                     await this.setSiblingIndex(newNodeId, args.siblingIndex);
                 }

                 await Editor.Message.request('scene', 'snapshot');
                 const copiedNode = await Editor.Message.request('scene', 'query-node', newNodeId);
                 const copiedNodeUuid = typeof copiedNode?.uuid === 'string' ? copiedNode.uuid : copiedNode?.uuid?.value;
                 if (!copiedNode || copiedNodeUuid !== newNodeId) {
                    throw new ToolError({ code: 'NODE_COPY_UNCONFIRMED', status: 502, message: `Creator did not confirm duplicated node ${newNodeId}.` });
                 }
                 if (args.newParentReference) {
                    const copiedParent = copiedNode.parent?.value?.uuid ?? copiedNode.parent?.uuid;
                    if (copiedParent !== args.newParentReference.id) {
                        throw new ToolError({
                            code: 'NODE_COPY_UNCONFIRMED', status: 502,
                            message: `Creator did not confirm duplicated node ${newNodeId} under parent ${args.newParentReference.id}.`,
                            details: { nodeId: newNodeId, requestedParentId: args.newParentReference.id, actualParentId: copiedParent ?? null },
                        });
                    }
                 }
                 return { success: true, copiedNodeReference: { id: newNodeId, type: 'cc.Node' } };

            case 'delete':
                await Editor.Message.request('scene', 'remove-node', {
                    uuid: args.reference.id
                });

                const nodeCheck = await Editor.Message.request('scene', 'query-node', args.reference.id);
                if (nodeCheck !== null && nodeCheck !== undefined) {
                    throw new Error(`Node ${args.reference.id} still exists after removal`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'lock':
            case 'unlock':
                await Editor.Message.request('scene', 'change-node-lock',
                    args.reference.id, args.operation === 'lock', !!args.recursive);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };

            case 'create_prefab':
                if (!args.newPrefabPath) {
                    throw new Error("newPrefabPath required for create_prefab");
                }
                const parentInfo = await this.getParentAndSiblingIndex(args.reference.id);

                const createdPrefabUuid = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'createPrefabFromNode',
                    args: [args.reference.id, args.newPrefabPath]
                });
                
                if (!createdPrefabUuid) {
                    throw new Error("Failed to create prefab asset.");
                }
                const updatedNodeId = await this.getUpdatedUuid(parentInfo.parentUuid, parentInfo.siblingIndex);

                await Editor.Message.request('scene', 'snapshot');

                return { success: true, createdPrefabAssetReference: { id: createdPrefabUuid, type: 'cc.Prefab' }, updatedNodeReference: { id: updatedNodeId, type: 'cc.Node' } };

            case 'link_prefab': {
                if (!args.prefabAssetReference || !args.prefabAssetReference.id) {
                    throw new Error('prefabAssetReference required for link_prefab');
                }
                const prefabInfo = await Editor.Message.request('asset-db', 'query-asset-info', args.prefabAssetReference.id);
                if (!prefabInfo) {
                    throw new Error(`Prefab asset ${args.prefabAssetReference.id} not found`);
                }
                await Editor.Message.request('scene', 'link-prefab', args.reference.id, args.prefabAssetReference.id);
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };
            }
            case 'revert_prefab':
                // restore-prefab is result: boolean — a false/undefined return means the node
                // was NOT reverted; reporting it as opaque data is a docs §2 silent failure.
                const revertSuccess = await restorePrefabNode(args.reference.id);
                if (revertSuccess !== true) {
                    throw new Error(`revert_prefab failed: restore-prefab returned ${JSON.stringify(revertSuccess ?? null)} for ${args.reference.id}`);
                }
                await Editor.Message.request('scene', 'snapshot');
                return { success: true };

            case 'apply_prefab':
                const applyError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'applyPrefabByNode',
                    args: [args.reference.id]
                });

                if (applyError != null) {
                    throw new Error(`Failed to apply prefab: ${applyError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'unwrap_prefab':
                const unwrapError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'unlinkPrefabByNode',
                    args: [args.reference.id, false]
                });
                
                if (unwrapError != null) {
                    throw new Error(`Failed to unwrap prefab: ${unwrapError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'unwrap_prefab_completely':
                const unwrapAllError = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: packageJSON.name,
                    method: 'unlinkPrefabByNode',
                    args: [args.reference.id, true]
                });
                
                if (unwrapAllError != null) {
                    throw new Error(`Failed to unwrap prefab completely: ${unwrapAllError}`);
                }

                await Editor.Message.request('scene', 'snapshot');

                return { success: true };

            case 'open_prefab':
                const nodeForPrefab: any = await Editor.Message.request('scene', 'query-node', args.reference.id);
                if (!nodeForPrefab) {
                    throw new Error(`Node ${args.reference.id} not found`);
                }
                 
                const pInfo = nodeForPrefab.__prefab__ || nodeForPrefab._prefab || (nodeForPrefab.value && (nodeForPrefab.value.__prefab__ || nodeForPrefab.value._prefab));
                const pValue = pInfo?.value || pInfo;
                const targetUuid = pValue?.assetUuid || pValue?.uuid;

                if (!targetUuid) {
                    throw new Error(`Node ${args.reference.id} is not linked to a prefab`);
                }

                try { 
                    await Editor.Message.request('asset-db', 'open-asset', targetUuid);
                } catch (error: any) {
                    throw new Error(`Failed to open prefab asset ${targetUuid}. Reason: ${error?.message || error}`);
                }

                return { success: true };

            default:
                throw new Error(`Unknown scene node operation: ${args.operation}`);
        }
    }

    // Helpers

    private treeNodeName(node: SceneTreeNode): string {
        if (typeof node.name === 'string') return node.name;
        return node.name?.value ?? node.uuid ?? '';
    }

    private findTreeNode(root: SceneTreeNode, uuid: string): SceneTreeNode | null {
        const stack: SceneTreeNode[] = [root];
        while (stack.length) {
            const node = stack.pop()!;
            if (node.uuid === uuid) return node;
            const children = node.children ?? [];
            for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
        }
        return null;
    }

    /**
     * When a prefab is open for editing, 'query-current-scene' reports the prefab
     * ASSET uuid rather than a scene uuid. Walk the wrapper hierarchy for the node
     * whose __prefab__ marks it as that asset's root and return its subtree.
     * Returns null in ordinary scene mode, or if no such root is found.
     */
    private async findPrefabEditRoot(sceneTree: any): Promise<any | null> {
        if (!sceneTree) return null;

        const current: any = await Editor.Message.request('scene', 'query-current-scene');
        const openUuid = typeof current === 'string' ? current : current?.uuid;
        if (!openUuid) return null;

        // A real scene's root IS the open asset — nothing to unwrap.
        if (sceneTree.uuid === openUuid) return null;

        const asset = await Editor.Message.request('asset-db', 'query-asset-info', openUuid);
        if (!asset || asset.type !== 'cc.Prefab') return null;

        // Breadth-first: the prefab root is the shallowest node claiming to be one.
        const queue: any[] = [sceneTree];
        while (queue.length) {
            const node = queue.shift();
            if (!node) continue;

            if (node.uuid && node.uuid !== sceneTree.uuid) {
                const dump: any = await Editor.Message.request('scene', 'query-node', node.uuid)
                    .catch(() => null);
                const prefab = dump?.__prefab__?.value ?? dump?.__prefab__;
                const assetUuid = prefab?.prefabStateInfo?.assetUuid ?? prefab?.uuid;
                if (prefab && assetUuid === openUuid && prefab.rootUuid === node.uuid) {
                    return node;
                }
            }

            for (const child of node.children ?? []) {
                queue.push(child);
            }
        }

        return null;
    }

    private async getParent(nodeUuid: string): Promise<string> {
        const node = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (node?.parent?.value?.uuid) return node.parent.value.uuid;
        if (node?.parent?.uuid) return node.parent.uuid;

        // No parent recorded — the node sits directly under the scene root, so the
        // scene itself is the parent. 'scene:query-uuid' was used here before and
        // exists in neither 3.7.3 nor 3.8.7, meaning this path always threw.
        // query-current-scene returns either a uuid string or a scene info object.
        const current = await Editor.Message.request('scene', 'query-current-scene');
        if (typeof current === 'string') return current;
        return (current as any)?.uuid ?? '';
    }

    // Helper to set sibling index
    private async setSiblingIndex(uuid: string, index: number) {
        // Get parent first
        const parentUuid = await this.getParent(uuid);
        if (!parentUuid) {
            throw new Error(`Node ${uuid} has no parent`);
        }

        // Get children of parent
        const parentNode = await Editor.Message.request('scene', 'query-node', parentUuid);
        const childrenArray = parentNode.children;
        if (!childrenArray || !Array.isArray(childrenArray)) {
            throw new Error(`Parent node ${parentUuid} has no children`);
        }

        const currentIndex = childrenArray.findIndex((child: any) => child.value.uuid === uuid);
        if (currentIndex === -1) {
            throw new Error(`Node ${uuid} not found in parent children`);
        }

        if (currentIndex === index) return true;

        // Clamp hid an out-of-range request: the agent asked for index N, got the last
        // slot, and read `success`. Reject it — class, state and recovery are all known.
        if (index < 0 || index > childrenArray.length - 1) {
            throw new ToolError({
                code: 'INDEX_OUT_OF_RANGE',
                status: 422,
                message: `siblingIndex ${index} is out of range for parent ${parentUuid} (0..${childrenArray.length - 1})`,
                details: { index, maxIndex: childrenArray.length - 1, parentUuid },
                recovery: 'Pass siblingIndex between 0 and the parent child count minus one, or query nodeGetTree first.',
            });
        }

        const offset = index - currentIndex;

        if (offset === 0) return true;

        const moved = await Editor.Message.request('scene', 'move-array-element', {
            uuid: parentUuid,
            path: 'children',
            target: currentIndex,
            offset: offset,
        });
        if (moved === false) throw new Error(`move-array-element refused for ${uuid} (offset ${offset})`);
        return moved;
    }

    private async getParentAndSiblingIndex(uuid: string): Promise<{ parentUuid: string, siblingIndex: number }> {
        const parentUuid = await this.getParent(uuid);
        if (!parentUuid) {
            throw new Error(`Node ${uuid} has no parent`);
        }

        const parentNode = await Editor.Message.request('scene', 'query-node', parentUuid);
        const childrenArray = parentNode.children;
        if (!childrenArray || !Array.isArray(childrenArray)) {
            throw new Error(`Parent node ${parentUuid} has no children`);
        }
        const index = childrenArray.findIndex((child: any) => child.value.uuid === uuid);
        if (index === -1) {
            throw new Error(`Node ${uuid} not found in parent children`);
        }
        return { parentUuid, siblingIndex: index };
    }
    
    private async getUpdatedUuid(parentUuid: string, siblingIndex: number): Promise<string> {
        const parentNodeInfo = await Editor.Message.request('scene', 'query-node', parentUuid);
        if (!parentNodeInfo || !parentNodeInfo.children || !Array.isArray(parentNodeInfo.children) || !parentNodeInfo.children[siblingIndex]) {
            throw new Error(`Failed to retrieve updated node info after prefab creation.`);
        }
        return parentNodeInfo.children[siblingIndex].value.uuid;
    }
}