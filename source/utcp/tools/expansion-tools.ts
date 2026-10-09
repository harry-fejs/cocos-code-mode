import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { IProperty } from '@cocos/creator-types/editor/packages/scene/@types/public';
import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { AUDIO_TARGETS, AudioAssetInfo, AudioAssetReference, AudioCompatibilityAuditResult, AudioTarget, buildAudioAssetCompatibilityAudit } from '../../audio-asset-compatibility-audit';
const AUDIO_COMPAT_ISSUE_SCHEMA: any = {
    type: 'object',
    additionalProperties: false,
    properties: {
        code: { type: 'string', enum: ['ASSET_NOT_FOUND', 'TYPE_MISMATCH', 'UNSUPPORTED_FORMAT', 'UNKNOWN_METADATA', 'IMPORT_FAILED', 'TARGET_UNSUPPORTED'] },
        assetId: { type: 'string' },
        field: { type: 'string' },
        value: {},
        message: { type: 'string' },
    },
    required: ['code', 'assetId', 'message'],
};
const AUDIO_COMPAT_ITEM_SCHEMA: any = {
    type: 'object',
    additionalProperties: false,
    properties: {
        reference: { type: 'object' },
        target: { type: 'string', enum: [...AUDIO_TARGETS] },
        valid: { type: 'boolean' },
        url: { type: 'string' },
        path: { type: 'string' },
        extension: { type: 'string' },
        importer: { type: 'string' },
        loadMode: { type: 'string' },
        issues: { type: 'array', maxItems: 256, items: AUDIO_COMPAT_ISSUE_SCHEMA },
    },
    required: ['reference', 'target', 'valid', 'issues'],
};

interface ComponentRecord { type?: string; cid?: string; value?: Record<string, any>; }
interface NodeRecord { uuid?: string; name?: any; children?: NodeRecord[]; __comps__?: ComponentRecord[]; }

async function sceneNodes(rootUuid?: string): Promise<NodeRecord[]> {
    const tree = (rootUuid ? await Editor.Message.request('scene', 'query-node-tree', rootUuid) : await Editor.Message.request('scene', 'query-node-tree')) as unknown as NodeRecord | null;
    if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'Scene subtree not found' });
    const result: NodeRecord[] = [];
    const visit = async (node: NodeRecord): Promise<void> => {
        if (result.length >= 128 || !node.uuid) return;
        const dump = await Editor.Message.request('scene', 'query-node', node.uuid) as unknown as NodeRecord | null;
        if (!dump) return;
        result.push(dump);
        for (const child of node.children ?? []) await visit(child);
    };
    await visit(tree);
    return result;
}

function nodeName(node: NodeRecord): string { return typeof node.name === 'string' ? node.name : node.name?.value ?? node.uuid ?? ''; }
function componentType(component: ComponentRecord): string {
    return component.type ?? component.value?.__type__?.value ?? component.value?.__type__ ?? component.cid ?? component.value?.cid ?? '';
}
function componentTypes(node: NodeRecord): string[] { return (node.__comps__ ?? []).map(componentType).filter(Boolean); }
function audioProperties(component: ComponentRecord): Record<string, unknown> { return component.value ?? {}; }
function propertyValue(value: unknown): unknown {
    if (!value || typeof value !== 'object' || !('value' in value)) return value;
    return value.value;
}
function componentUuid(component: ComponentRecord | undefined): unknown {
    const raw = component as (ComponentRecord & { uuid?: unknown }) | undefined;
    return propertyValue(component?.value?.uuid ?? raw?.uuid);
}

function referenceUuid(value: unknown): string | undefined {
    const unwrapped = propertyValue(value);
    if (typeof unwrapped === 'string' && unwrapped) return unwrapped;
    if (!unwrapped || typeof unwrapped !== 'object') return undefined;
    const uuid = propertyValue((unwrapped as Record<string, unknown>).uuid);
    return typeof uuid === 'string' && uuid ? uuid : undefined;
}

function cloneDump<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function dumpsEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
async function hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', resolve);
    });
    return hash.digest('hex');
}

export class ExpansionTools {
    @utcpTool('particleInspect', 'Inspect bounded particle system components and serialized configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { systems: { type: 'array' }, count: { type: 'integer' } }, required: ['systems', 'count'] }, 'GET', ['particle', 'inspect'])
    async particleInspect(args: { reference?: IInstanceReference }): Promise<{ systems: Array<Record<string, unknown>>, count: number }> {

        const nodes = await sceneNodes(args.reference?.id);
        const systems = nodes.flatMap((node) => (node.__comps__ ?? [])
            .filter((component) => /cc\.ParticleSystem(?:2D)?$/.test(componentType(component)))
            .map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), type: componentType(component), properties: component.value ?? {} })));
        return { systems, count: systems.length };
    }
    @utcpTool('particleConfigure', 'Configure bounded serialized particle module/curve fields with snapshot, read-back, and rollback; never claims runtime playback.', {
        type: 'object', additionalProperties: false,
        properties: {
            reference: InstanceReferenceSchema,
            properties: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 16 },
        },
        required: ['reference', 'properties'],
    }, {
        type: 'object', additionalProperties: false,
        properties: { reference: InstanceReferenceSchema, componentReference: InstanceReferenceSchema, properties: { type: 'object' }, changed: { type: 'array' }, verified: { type: 'boolean', const: true } },
        required: ['reference', 'componentReference', 'properties', 'changed', 'verified'],
    }, 'POST', ['particle', 'configure', 'scene'])
    async particleConfigure(args: { reference: IInstanceReference, properties: Record<string, unknown> }): Promise<{ reference: IInstanceReference, componentReference: IInstanceReference, properties: Record<string, unknown>, changed: string[], verified: true }> {
        if (!args?.reference?.id || typeof args.reference.id !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'reference.id is required.' });
        if (!args.properties || typeof args.properties !== 'object' || Array.isArray(args.properties)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'properties must be a non-empty object.' });
        const keys = Object.keys(args.properties);
        if (keys.length < 1 || keys.length > 16 || keys.some((key) => !/^[A-Za-z0-9_.]{1,256}$/.test(key))) throw new ToolError({ code: 'INVALID_PROPERTY', status: 400, message: 'Particle property paths must be 1 to 256 alphanumeric segments.' });
        const node = await (Editor.Message.request('scene', 'query-node', args.reference.id) as unknown as Promise<NodeRecord | null>);
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Scene node ${args.reference.id} was not found.` });
        const components = node.__comps__ ?? [];
        const index = components.findIndex((component) => /cc\.ParticleSystem(?:2D)?$/.test(componentType(component)));
        if (index < 0) throw new ToolError({ code: 'UNSUPPORTED_COMPONENT', status: 422, message: `Node ${args.reference.id} has no serialized particle system component.` });
        const component = components[index];
        const values = component.value ?? {};
        const readPath = (root: unknown, propertyPath: string): unknown => propertyPath.split('.').reduce((current: unknown, part: string) => {
            if (!current || typeof current !== 'object' || !(part in (current as Record<string, unknown>))) return undefined;
            const next = (current as Record<string, unknown>)[part];
            return next && typeof next === 'object' && !Array.isArray(next) && 'value' in next ? (next as Record<string, unknown>).value : next;
        }, root);
        const originals: Record<string, unknown> = {};
        for (const key of keys) {
            const value = readPath(values, key);
            if (value === undefined) throw new ToolError({ code: 'UNSUPPORTED_PROPERTY', status: 422, message: `Particle component does not expose serialized field ${key}.` });
            originals[key] = cloneDump(value);
        }
        const componentId = referenceUuid(componentUuid(component));
        const componentReference = { id: componentId ?? `${args.reference.id}:component:${index}`, type: componentType(component) || 'cc.ParticleSystem' };
        const applied: string[] = [];
        try {
            for (const key of keys) {
                const result = await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: `__comps__.${index}.${key}`, dump: { value: args.properties[key] as never, type: 'Unknown' } });
                if (result === false) throw new Error(`Creator refused ${key}`);
                applied.push(key);
            }
            await Editor.Message.request('scene', 'snapshot');
            const readBackNode = await (Editor.Message.request('scene', 'query-node', args.reference.id) as unknown as Promise<NodeRecord | null>);
            const readBackValues = readBackNode?.__comps__?.[index]?.value ?? {};
            const readBack: Record<string, unknown> = {};
            for (const key of keys) {
                const actual = readPath(readBackValues, key);
                if (JSON.stringify(actual) !== JSON.stringify(args.properties[key])) throw new Error(`read-back mismatch for ${key}`);
                readBack[key] = actual;
            }
            return { reference: { id: args.reference.id, type: args.reference.type ?? 'cc.Node' }, componentReference, properties: readBack, changed: keys, verified: true };
        } catch (error) {
            try {
                for (const key of [...applied].reverse()) await Editor.Message.request('scene', 'set-property', { uuid: args.reference.id, path: `__comps__.${index}.${key}`, dump: { value: originals[key] as never, type: 'Unknown' } });
                await Editor.Message.request('scene', 'snapshot');
            } catch (rollbackError) {
                throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: `Particle configuration failed and node ${args.reference.id} could not be restored.`, details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) } });
            }
            throw new ToolError({ code: 'MUTATION_FAILED', status: 502, message: `Particle configuration failed for node ${args.reference.id}.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
    @utcpTool('terrainInspect', 'Inspect bounded Terrain components and their asset/effect configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { terrains: { type: 'array' }, count: { type: 'integer' } }, required: ['terrains', 'count'] }, 'GET', ['terrain', 'inspect'])
    async terrainInspect(args: { reference?: IInstanceReference }): Promise<{ terrains: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const terrains = nodes.flatMap((node) => (node.__comps__ ?? [])
            .filter((component) => componentType(component) === 'cc.Terrain')
            .map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), properties: component.value ?? {} })));
        return { terrains, count: terrains.length };
    }
    @utcpTool('localizationInspect', 'Inspect bounded Creator localization runtime availability, languages and text direction.', { type: 'object', properties: {} }, { type: 'object', properties: { supported: { type: 'boolean' }, currentLanguage: { type: ['string', 'null'] }, languages: { type: 'array' }, directions: { type: 'object' }, error: { type: 'string' } }, required: ['supported', 'currentLanguage', 'languages', 'directions'] }, 'GET', ['localization', 'inspect'])
    async localizationInspect(): Promise<{ supported: boolean, currentLanguage: string | null, languages: string[], directions: Record<string, string>, error?: string }> {
        return await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'inspectLocalization', args: [] }) as any;
    }

    @utcpTool('particleValidate', 'Validate bounded particle system presence and serialized component configuration.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['particle', 'validate'])
    async particleValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const result = await this.particleInspect(args);
        const issues = result.systems.length === 0 ? ['no particle system component found'] : [];
        return { valid: issues.length === 0, issues, checkedNodes: result.count };
    }

    @utcpTool('physics2dInspect', 'Inspect bounded 2D physics bodies and colliders in the open scene.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { nodes: { type: 'array' }, count: { type: 'integer' } }, required: ['nodes', 'count'] }, 'GET', ['physics', '2d', 'inspect'])
    async physics2dInspect(args: { reference?: IInstanceReference }): Promise<{ nodes: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const rows = nodes.map((node) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), components: componentTypes(node).filter((type) => /RigidBody2D|Collider2D|Joint2D|PhysicsSystem2D/.test(type)) })).filter((row) => row.components.length > 0);
        return { nodes: rows, count: rows.length };
    }

    @utcpTool('physics2dValidate', 'Validate incomplete 2D rigid-body and collider combinations.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['physics', '2d', 'validate'])
    async physics2dValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const rows = await this.physics2dInspect(args);
        const issues: string[] = [];
        for (const row of rows.nodes) {
            const components = row.components as string[];
            if (components.some((type) => type === 'cc.RigidBody2D') && !components.some((type) => type.includes('Collider2D'))) issues.push(`${row.name}: rigid body has no 2D collider`);
        }
        return { valid: issues.length === 0, issues, checkedNodes: rows.count };
    }

    @utcpTool('physics2dTopologyAudit', 'Audit bounded 2D physics body, collider and joint topology without assuming a backend.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '2d', 'topology', 'audit'])
    async physics2dTopologyAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const topology = nodes.map((node) => {
            const types = componentTypes(node);
            const bodies = types.filter((type) => type === 'cc.RigidBody2D');
            const colliders = types.filter((type) => /Collider2D$/.test(type));
            const joints = types.filter((type) => /Joint2D$/.test(type));
            if (bodies.length > 0 && colliders.length === 0) issues.push(`${nodeName(node)}: rigid body has no collider`);
            if (joints.length > 0 && bodies.length === 0) issues.push(`${nodeName(node)}: joint has no rigid body on the same node`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), bodies, colliders, joints };
        }).filter((row) => row.bodies.length > 0 || row.colliders.length > 0 || row.joints.length > 0);
        return { valid: issues.length === 0, nodes: topology, issues, checkedNodes: topology.length };
    }

    @utcpTool(
        'physics2dCompatibilityAudit',
        'Validate bounded 2D physics components against an explicit Creator backend capability matrix.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'], description: 'Target Creator 2D physics backend.' },
                reference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                valid: { type: 'boolean' },
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                nodes: { type: 'array' },
                issues: { type: 'array', items: { type: 'string' } },
                checkedNodes: { type: 'integer' },
            },
            required: ['valid', 'backend', 'nodes', 'issues', 'checkedNodes'],
        },
        'GET',
        ['physics', '2d', 'compatibility', 'backend', 'audit']
    )
    async physics2dCompatibilityAudit(args: { backend: 'builtin' | 'box2d', reference?: IInstanceReference }): Promise<{ valid: boolean, backend: 'builtin' | 'box2d', nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const topology = await this.physics2dTopologyAudit({ reference: args.reference });
        const issues = [...topology.issues];
        if (args.backend === 'builtin') {
            for (const row of topology.nodes) {
                const bodies = row.bodies as string[];
                const joints = row.joints as string[];
                if (bodies.length > 0) issues.push(`${row.name}: ${bodies.join(', ')} requires the box2d backend`);
                if (joints.length > 0) issues.push(`${row.name}: ${joints.join(', ')} requires the box2d backend`);
            }
        }
        return { valid: issues.length === 0, backend: args.backend, nodes: topology.nodes, issues, checkedNodes: topology.checkedNodes };
    }

    @utcpTool(
        'physics2dCreateBody',
        'Create one verified Box2D rigid-body node with a bounded collider choice, snapshot, read-back, and rollback on failure.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                collider: { type: 'string', enum: ['box', 'circle'], default: 'box' },
                name: { type: 'string', minLength: 1, maxLength: 128, default: 'Physics2DBody' },
                parentReference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                backend: { type: 'string', enum: ['box2d'] },
                bodyType: { type: 'string' },
                colliderType: { type: 'string' },
                components: { type: 'array', items: { type: 'string' } },
            },
            required: ['reference', 'backend', 'bodyType', 'colliderType', 'components'],
        },
        'POST',
        ['physics', '2d', 'create', 'body', 'collider', 'compound']
    )
    async physics2dCreateBody(args: { backend: 'builtin' | 'box2d', collider?: 'box' | 'circle', name?: string, parentReference?: IInstanceReference }): Promise<{ reference: IInstanceReference, backend: 'box2d', bodyType: string, colliderType: string, components: string[] }> {
        if (args.backend !== 'box2d') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: 'physics2dCreateBody requires the box2d backend; Creator Builtin provides collision detection without rigid bodies.',
                recovery: 'Select the box2d backend or create collider-only nodes with the ordinary component tools.',
            });
        }
        const colliderType = args.collider === 'circle' ? 'cc.CircleCollider2D' : 'cc.BoxCollider2D';
        let nodeUuid: string | undefined;
        try {
            let parentUuid = args.parentReference?.id;
            if (parentUuid) {
                const parent = await Editor.Message.request('scene', 'query-node', parentUuid);
                if (!parent) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${parentUuid} not found` });
            } else {
                const root = await Editor.Message.request('scene', 'query-node-tree') as unknown as NodeRecord | null;
                parentUuid = root?.uuid;
                if (!parentUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Open scene root not found' });
            }
            const created = await Editor.Message.request('scene', 'create-node', { name: args.name ?? 'Physics2DBody', parent: parentUuid });
            nodeUuid = Array.isArray(created) ? created[0] : created;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Creator did not return a node UUID');
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: 'cc.RigidBody2D' });
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: colliderType });
            await Editor.Message.request('scene', 'snapshot');
            const dump = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const components = dump ? componentTypes(dump) : [];
            if (!dump || !components.includes('cc.RigidBody2D') || !components.includes(colliderType)) {
                throw new Error(`Creator read-back did not contain cc.RigidBody2D and ${colliderType}`);
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                backend: 'box2d',
                bodyType: 'cc.RigidBody2D',
                colliderType,
                components,
            };
        } catch (error) {
            if (nodeUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-node', { uuid: nodeUuid });
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics2dCreateBody failed and node ${nodeUuid} could not be rolled back`,
                        details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
                        recovery: `Delete node ${nodeUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }

    @utcpTool(
        'physics2dCreateJoint',
        'Create one verified Box2D 2D joint between two existing rigid-body nodes with endpoint validation and rollback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'box2d'] },
                joint: { type: 'string', enum: ['distance', 'spring', 'hinge', 'slider', 'fixed'], default: 'distance' },
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
            },
            required: ['backend', 'bodyReference', 'connectedBodyReference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['box2d'] },
                jointReference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
                jointType: { type: 'string' },
            },
            required: ['backend', 'jointReference', 'bodyReference', 'connectedBodyReference', 'jointType'],
        },
        'POST',
        ['physics', '2d', 'create', 'joint', 'compound']
    )
    async physics2dCreateJoint(args: { backend: 'builtin' | 'box2d', joint?: 'distance' | 'spring' | 'hinge' | 'slider' | 'fixed', bodyReference: IInstanceReference, connectedBodyReference: IInstanceReference }): Promise<{ backend: 'box2d', jointReference: IInstanceReference, bodyReference: IInstanceReference, connectedBodyReference: IInstanceReference, jointType: string }> {
        if (args.backend !== 'box2d') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: 'physics2dCreateJoint requires the box2d backend; Creator Builtin does not support 2D joints.',
                recovery: 'Select the box2d backend or omit the joint and use collider-only nodes.',
            });
        }
        if (args.bodyReference.id === args.connectedBodyReference.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A 2D joint requires two distinct rigid-body nodes' });
        }
        const body = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
        const connected = await Editor.Message.request('scene', 'query-node', args.connectedBodyReference.id) as unknown as NodeRecord | null;
        if (!body) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Body node ${args.bodyReference.id} not found` });
        if (!connected) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Connected body node ${args.connectedBodyReference.id} not found` });
        const componentUuid = (component: ComponentRecord): string | undefined => component.value?.uuid?.value ?? component.value?.uuid ?? component.cid ?? component.value?.cid;
        const bodyComponent = body.__comps__?.find((component) => componentType(component) === 'cc.RigidBody2D');
        const connectedBodyComponent = connected.__comps__?.find((component) => componentType(component) === 'cc.RigidBody2D');
        if (!bodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Body node ${args.bodyReference.id} has no cc.RigidBody2D` });
        if (!connectedBodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Connected body node ${args.connectedBodyReference.id} has no cc.RigidBody2D` });
        const connectedBodyUuid = componentUuid(connectedBodyComponent);
        if (!connectedBodyUuid) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Connected body ${args.connectedBodyReference.id} has no serialized component UUID` });
        const jointType = ({
            distance: 'cc.DistanceJoint2D',
            spring: 'cc.SpringJoint2D',
            hinge: 'cc.HingeJoint2D',
            slider: 'cc.SliderJoint2D',
            fixed: 'cc.FixedJoint2D',
        } as const)[args.joint ?? 'distance'];
        let jointUuid: string | undefined;
        const containsUuid = (value: unknown, uuid: string): boolean => {
            if (value === uuid) return true;
            if (!value || typeof value !== 'object') return false;
            return Object.values(value as Record<string, unknown>).some((item) => containsUuid(item, uuid));
        };
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: args.bodyReference.id, component: jointType });
            const afterCreate = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
            const joint = afterCreate?.__comps__?.find((component) => componentType(component) === jointType);
            jointUuid = joint ? componentUuid(joint) : undefined;
            if (!jointUuid) throw new Error(`Creator did not return the ${jointType} component UUID`);
            const jointIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === jointType) ?? -1;
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: args.bodyReference.id,
                path: `_components.${jointIndex}.connectedBody`,
                dump: { value: { uuid: connectedBodyUuid }, type: 'cc.RigidBody2D' },
            });
            if (setResult === false) throw new Error(`Creator refused connectedBody assignment for ${jointType}`);
            await Editor.Message.request('scene', 'snapshot');
            const verified = await Editor.Message.request('scene', 'query-node', args.bodyReference.id) as unknown as NodeRecord | null;
            const verifiedJoint = verified?.__comps__?.find((component) => componentType(component) === jointType);
            if (!verifiedJoint || !containsUuid(verifiedJoint.value, connectedBodyUuid)) {
                throw new Error(`Creator read-back did not verify ${jointType}.connectedBody`);
            }
            return {
                backend: 'box2d',
                jointReference: { id: jointUuid, type: jointType },
                bodyReference: args.bodyReference,
                connectedBodyReference: args.connectedBodyReference,
                jointType,
            };
        } catch (error) {
            if (jointUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-component', { uuid: jointUuid });
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics2dCreateJoint failed and joint ${jointUuid} could not be rolled back`,
                        details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) },
                        recovery: `Remove component ${jointUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }
    @utcpTool(
        'physics3dCreateBody',
        'Create one verified PhysX rigid-body node with a bounded box collider, serialized size, and rollback on failure.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'cannon', 'physx'], description: 'Target Creator 3D physics backend.' },
                collider: { type: 'string', enum: ['box', 'sphere', 'capsule', 'mesh'], default: 'box' },
                size: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        x: { type: 'number', minimum: 0.001, maximum: 100000 },
                        y: { type: 'number', minimum: 0.001, maximum: 100000 },
                        z: { type: 'number', minimum: 0.001, maximum: 100000 },
                    },
                    required: ['x', 'y', 'z'],
                    default: { x: 1, y: 1, z: 1 },
                },
                name: { type: 'string', minLength: 1, maxLength: 128, default: 'Physics3DBody' },
                parentReference: InstanceReferenceSchema,
            },
            required: ['backend'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                colliderReference: InstanceReferenceSchema,
                backend: { type: 'string', enum: ['physx'] },
                bodyType: { type: 'string', enum: ['cc.RigidBody'] },
                colliderType: { type: 'string', enum: ['cc.BoxCollider'] },
                collider: { type: 'string', enum: ['box'] },
                size: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        x: { type: 'number' },
                        y: { type: 'number' },
                        z: { type: 'number' },
                    },
                    required: ['x', 'y', 'z'],
                },
                components: { type: 'array', items: { type: 'string' } },
                verified: { type: 'boolean' },
            },
            required: ['reference', 'bodyReference', 'colliderReference', 'backend', 'bodyType', 'colliderType', 'collider', 'size', 'components', 'verified'],
        },
        'POST',
        ['physics', '3d', 'create', 'body', 'collider', 'compound']
    )
    async physics3dCreateBody(args: {
        backend: 'builtin' | 'cannon' | 'physx',
        collider?: 'box' | 'sphere' | 'capsule' | 'mesh',
        size?: { x: number, y: number, z: number },
        name?: string,
        parentReference?: IInstanceReference,
    }): Promise<{
        reference: IInstanceReference,
        bodyReference: IInstanceReference,
        colliderReference: IInstanceReference,
        backend: 'physx',
        bodyType: 'cc.RigidBody',
        colliderType: 'cc.BoxCollider',
        collider: 'box',
        size: { x: number, y: number, z: number },
        components: string[],
        verified: true,
    }> {
        if (args.backend !== 'physx') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: `physics3dCreateBody supports only the bounded PhysX backend contract; "${args.backend}" is not supported for rigid-body creation.`,
                recovery: 'Select the physx backend or use ordinary component tools without a physics-backend claim.',
            });
        }
        const collider = args.collider ?? 'box';
        if (collider !== 'box') {
            throw new ToolError({
                code: 'UNSUPPORTED_COLLIDER',
                status: 422,
                message: `physics3dCreateBody supports only the bounded PhysX box collider contract; "${collider}" is not supported.`,
                recovery: 'Use collider "box"; create other collider classes only after their backend combination is qualified.',
            });
        }
        const size = args.size ?? { x: 1, y: 1, z: 1 };
        if (![size.x, size.y, size.z].every((value) => Number.isFinite(value) && value >= 0.001 && value <= 100000)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'physics3dCreateBody size axes must be finite numbers between 0.001 and 100000.',
            });
        }

        const bodyType = 'cc.RigidBody' as const;
        const colliderType = 'cc.BoxCollider' as const;
        const name = args.name ?? 'Physics3DBody';
        let nodeUuid: string | undefined;
        try {
            let parentUuid = args.parentReference?.id;
            if (parentUuid) {
                const parent = await Editor.Message.request('scene', 'query-node', parentUuid);
                if (!parent) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${parentUuid} not found` });
            } else {
                const root = await Editor.Message.request('scene', 'query-node-tree') as unknown as NodeRecord | null;
                parentUuid = root?.uuid;
                if (!parentUuid) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Open scene root not found' });
            }

            const created = await Editor.Message.request('scene', 'create-node', { name, parent: parentUuid });
            nodeUuid = Array.isArray(created) ? created[0] : created;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Creator did not return a node UUID');
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: bodyType });
            await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component: colliderType });

            const afterCreate = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const colliderIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === colliderType) ?? -1;
            if (!afterCreate || colliderIndex < 0 || !componentTypes(afterCreate).includes(bodyType)) {
                throw new Error(`Creator read-back did not contain ${bodyType} and ${colliderType}`);
            }
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: nodeUuid,
                path: `__comps__.${colliderIndex}.size`,
                dump: { value: size, type: 'cc.Vec3' },
            });
            if (setResult === false) throw new Error(`Creator refused ${colliderType}.size assignment`);
            await Editor.Message.request('scene', 'snapshot');

            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const verifiedComponents = verifiedNode?.__comps__ ?? [];
            const verifiedBody = verifiedComponents.find((component) => componentType(component) === bodyType);
            const verifiedCollider = verifiedComponents.find((component) => componentType(component) === colliderType);
            const verifiedSize = propertyValue(verifiedCollider?.value?.size) as Record<string, unknown> | undefined;
            const bodyUuid = propertyValue(verifiedBody?.value?.uuid);
            const colliderUuid = propertyValue(verifiedCollider?.value?.uuid);
            const components = verifiedNode ? componentTypes(verifiedNode) : [];
            if (
                !verifiedNode
                || nodeName(verifiedNode) !== name
                || typeof bodyUuid !== 'string'
                || typeof colliderUuid !== 'string'
                || verifiedSize?.x !== size.x
                || verifiedSize?.y !== size.y
                || verifiedSize?.z !== size.z
            ) {
                throw new Error(`Creator read-back did not verify ${name}, component references, and ${colliderType}.size`);
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                bodyReference: { id: bodyUuid, type: bodyType },
                colliderReference: { id: colliderUuid, type: colliderType },
                backend: 'physx',
                bodyType,
                colliderType,
                collider: 'box',
                size,
                components,
                verified: true,
            };
        } catch (error) {
            if (nodeUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-node', { uuid: nodeUuid });
                    const remaining = await Editor.Message.request('scene', 'query-node', nodeUuid);
                    if (remaining) throw new Error(`node ${nodeUuid} still exists after remove-node`);
                    await Editor.Message.request('scene', 'snapshot');
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `physics3dCreateBody failed and node ${nodeUuid} could not be rolled back`,
                        details: {
                            cause: error instanceof Error ? error.message : String(error),
                            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                            createdNode: { id: nodeUuid, type: 'cc.Node' },
                        },
                        recovery: `Delete node ${nodeUuid} manually before retrying.`,
                    });
                }
            }
            throw error;
        }
    }
    @utcpTool(
        'physics3dCreateJoint',
        'Create one verified PhysX 3D constraint between two existing rigid-body nodes with bounded endpoint validation and rollback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['builtin', 'cannon', 'physx'], description: 'Target Creator 3D physics backend.' },
                joint: { type: 'string', enum: ['fixed', 'hinge', 'pointToPoint', 'distance'], default: 'fixed', description: 'Bounded Creator 3D constraint type; distance is explicitly unsupported.' },
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
            },
            required: ['backend', 'bodyReference', 'connectedBodyReference'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                backend: { type: 'string', enum: ['physx'] },
                jointReference: InstanceReferenceSchema,
                bodyReference: InstanceReferenceSchema,
                connectedBodyReference: InstanceReferenceSchema,
                jointType: { type: 'string', enum: ['cc.FixedConstraint', 'cc.HingeConstraint', 'cc.PointToPointConstraint'] },
            },
            required: ['backend', 'jointReference', 'bodyReference', 'connectedBodyReference', 'jointType'],
        },
        'POST',
        ['physics', '3d', 'create', 'joint', 'compound']
    )
    async physics3dCreateJoint(args: {
        backend: 'builtin' | 'cannon' | 'physx',
        joint?: 'fixed' | 'hinge' | 'pointToPoint' | 'distance',
        bodyReference: IInstanceReference,
        connectedBodyReference: IInstanceReference,
    }): Promise<{
        backend: 'physx',
        jointReference: IInstanceReference,
        bodyReference: IInstanceReference,
        connectedBodyReference: IInstanceReference,
        jointType: 'cc.FixedConstraint' | 'cc.HingeConstraint' | 'cc.PointToPointConstraint',
    }> {
        if (args.backend !== 'physx') {
            throw new ToolError({
                code: 'UNSUPPORTED_BACKEND',
                status: 422,
                message: `physics3dCreateJoint supports only the bounded PhysX backend contract; "${args.backend}" is not supported for constraint creation.`,
                recovery: 'Select the physx backend or use ordinary component tools without a physics-backend claim.',
            });
        }
        const bodyId = args.bodyReference?.id;
        const connectedBodyId = args.connectedBodyReference?.id;
        if (typeof bodyId !== 'string' || !bodyId || typeof connectedBodyId !== 'string' || !connectedBodyId) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'physics3dCreateJoint requires non-empty bodyReference and connectedBodyReference ids.',
            });
        }
        if (bodyId === connectedBodyId) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'A 3D joint requires two distinct rigid-body nodes' });
        }

        const jointTypeByName: Record<string, 'cc.FixedConstraint' | 'cc.HingeConstraint' | 'cc.PointToPointConstraint'> = {
            fixed: 'cc.FixedConstraint',
            hinge: 'cc.HingeConstraint',
            pointToPoint: 'cc.PointToPointConstraint',
        };
        const jointType = jointTypeByName[args.joint ?? 'fixed'];
        if (!jointType) {
            throw new ToolError({
                code: 'UNSUPPORTED_JOINT',
                status: 422,
                message: `physics3dCreateJoint supports only fixed, hinge, and pointToPoint PhysX constraints; "${String(args.joint)}" is not supported.`,
                recovery: 'Use joint "fixed", "hinge", or "pointToPoint" with the physx backend.',
            });
        }

        const body = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
        const connected = await Editor.Message.request('scene', 'query-node', connectedBodyId) as unknown as NodeRecord | null;
        if (!body) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Body node ${bodyId} not found` });
        if (!connected) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Connected body node ${connectedBodyId} not found` });
        const bodyComponent = body.__comps__?.find((component) => componentType(component) === 'cc.RigidBody');
        const connectedBodyComponent = connected.__comps__?.find((component) => componentType(component) === 'cc.RigidBody');
        if (!bodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Body node ${bodyId} has no cc.RigidBody` });
        if (!connectedBodyComponent) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Connected body node ${connectedBodyId} has no cc.RigidBody` });
        const bodyComponentUuid = componentUuid(bodyComponent);
        const connectedBodyUuid = componentUuid(connectedBodyComponent);
        if (typeof bodyComponentUuid !== 'string' || !bodyComponentUuid) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Body ${bodyId} has no serialized cc.RigidBody component UUID` });
        }
        if (typeof connectedBodyUuid !== 'string' || !connectedBodyUuid) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `Connected body ${connectedBodyId} has no serialized cc.RigidBody component UUID` });
        }

        let jointUuid: string | undefined;
        try {
            const created = await Editor.Message.request('scene', 'create-component', { uuid: bodyId, component: jointType });
            if (typeof created === 'string' && created) jointUuid = created;
            const afterCreate = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
            const jointIndex = afterCreate?.__comps__?.findIndex((component) => componentType(component) === jointType) ?? -1;
            const joint = jointIndex >= 0 ? afterCreate?.__comps__?.[jointIndex] : undefined;
            const readBackJointUuid = joint ? componentUuid(joint) : undefined;
            if (typeof readBackJointUuid === 'string' && readBackJointUuid) jointUuid = readBackJointUuid;
            if (!afterCreate || jointIndex < 0 || typeof readBackJointUuid !== 'string' || !readBackJointUuid) {
                throw new Error(`Creator read-back did not contain ${jointType} with a serialized component UUID`);
            }
            const setResult = await Editor.Message.request('scene', 'set-property', {
                uuid: bodyId,
                path: `_components.${jointIndex}.connectedBody`,
                dump: { value: { uuid: connectedBodyUuid }, type: 'cc.RigidBody' },
            });
            if (setResult === false) throw new Error(`Creator refused ${jointType}.connectedBody assignment`);
            await Editor.Message.request('scene', 'snapshot');

            const verified = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
            const verifiedJoint = verified?.__comps__?.find((component) => componentType(component) === jointType);
            const containsUuid = (value: unknown, uuid: string): boolean => {
                if (value === uuid) return true;
                if (!value || typeof value !== 'object') return false;
                return Object.values(value as Record<string, unknown>).some((item) => containsUuid(item, uuid));
            };
            const verifiedJointUuid = componentUuid(verifiedJoint);
            if (
                !verifiedJoint
                || typeof verifiedJointUuid !== 'string'
                || !jointUuid
                || verifiedJointUuid !== jointUuid
                || !containsUuid(verifiedJoint.value?.connectedBody, connectedBodyUuid)
            ) {
                throw new Error(`Creator read-back did not verify ${jointType}.connectedBody and component UUID`);
            }
            const verifiedUuid = jointUuid;
            return {
                backend: 'physx',
                jointReference: { id: verifiedUuid, type: jointType },
                bodyReference: args.bodyReference,
                connectedBodyReference: args.connectedBodyReference,
                jointType,
            };
        } catch (error) {
            try {
                if (!jointUuid) {
                    const rollbackNode = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
                    const rollbackJoint = rollbackNode?.__comps__?.find((component) => componentType(component) === jointType);
                    const discoveredUuid = rollbackJoint ? componentUuid(rollbackJoint) : undefined;
                    if (typeof discoveredUuid === 'string' && discoveredUuid) jointUuid = discoveredUuid;
                }
                if (jointUuid) {
                    await Editor.Message.request('scene', 'remove-component', { uuid: jointUuid });
                    await Editor.Message.request('scene', 'snapshot');
                    const afterRollback = await Editor.Message.request('scene', 'query-node', bodyId) as unknown as NodeRecord | null;
                    const remains = afterRollback?.__comps__?.some((component) => componentUuid(component) === jointUuid);
                    if (remains) throw new Error(`joint component ${jointUuid} remains after rollback`);
                }
            } catch (rollbackError) {
                throw new ToolError({
                    code: 'ROLLBACK_FAILED',
                    status: 500,
                    message: `physics3dCreateJoint failed and the created joint could not be rolled back`,
                    details: {
                        cause: error instanceof Error ? error.message : String(error),
                        rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                        createdJoint: jointUuid ? { id: jointUuid, type: jointType } : undefined,
                    },
                    recovery: jointUuid ? `Remove component ${jointUuid} manually before retrying.` : 'Inspect the body node for an orphaned joint before retrying.',
                });
            }
            throw error;
        }
    }

    @utcpTool('physics3dInspect', 'Inspect bounded 3D rigid bodies, colliders, materials and joints in the open scene.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { nodes: { type: 'array' }, count: { type: 'integer' } }, required: ['nodes', 'count'] }, 'GET', ['physics', '3d', 'inspect'])
    async physics3dInspect(args: { reference?: IInstanceReference }): Promise<{ nodes: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const rows = nodes.map((node) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), components: componentTypes(node).filter((type) => /RigidBody$|Collider$|Joint$|Constraint$|PhysicsSystem/.test(type)) })).filter((row) => row.components.length > 0);
        return { nodes: rows, count: rows.length };
    }
    @utcpTool('physics3dTopologyAudit', 'Audit bounded 3D rigid body, collider, joint and physics-system topology.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, nodes: { type: 'array' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'nodes', 'issues', 'checkedNodes'] }, 'GET', ['physics', '3d', 'topology', 'audit'])
    async physics3dTopologyAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, nodes: Array<Record<string, unknown>>, issues: string[], checkedNodes: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const topology = nodes.map((node) => {
            const types = componentTypes(node);
            const bodies = types.filter((type) => /RigidBody$/.test(type));
            const colliders = types.filter((type) => /Collider$/.test(type));
            const joints = types.filter((type) => /Joint$|Constraint$/.test(type));
            const systems = types.filter((type) => /PhysicsSystem/.test(type));
            if (joints.length > 0 && bodies.length === 0) issues.push(`${nodeName(node)}: joint has no rigid body on the same node`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), bodies, colliders, joints, systems };
        }).filter((row) => row.bodies.length > 0 || row.colliders.length > 0 || row.joints.length > 0 || row.systems.length > 0);
        return { valid: issues.length === 0, nodes: topology, issues, checkedNodes: topology.length };
    }
    @utcpTool('physics3dValidate', 'Validate bounded 3D physics topology and report missing collider/body relationships.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, checkedNodes: { type: 'integer' } }, required: ['valid', 'issues', 'checkedNodes'] }, 'GET', ['physics', '3d', 'validate'])
    async physics3dValidate(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, issues: string[], checkedNodes: number }> {
        const result = await this.physics3dTopologyAudit(args);
        const issues = [...result.issues];
        for (const row of result.nodes) {
            const bodies = row.bodies as string[];
            const colliders = row.colliders as string[];
            if (bodies.length > 0 && colliders.length === 0) issues.push(`${row.name}: rigid body has no 3D collider`);
        }
        return { valid: issues.length === 0, issues, checkedNodes: result.checkedNodes };
    }

    @utcpTool('audioSourceInspect', 'Inspect bounded AudioSource components and normalized clip/playback properties.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { sources: { type: 'array' }, count: { type: 'integer' } }, required: ['sources', 'count'] }, 'GET', ['audio', 'inspect', 'source'])
    async audioSourceInspect(args: { reference?: IInstanceReference }): Promise<{ sources: Array<Record<string, unknown>>, count: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const sources = nodes.flatMap((node) => (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource').map((component) => ({ node: { id: node.uuid, type: 'cc.Node' }, name: nodeName(node), properties: audioProperties(component) })));
        return { sources, count: sources.length };
    }
    @utcpTool(
        'audioSourceConfigure',
        'Configure bounded serialized AudioSource properties on one existing node or component, with typed preflight, read-back, and rollback. Does not start or otherwise control playback.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        id: { type: 'string', minLength: 1 },
                        type: { type: 'string', enum: ['cc.Node', 'cc.AudioSource'] },
                    },
                    required: ['id', 'type'],
                },
                properties: {
                    type: 'object',
                    additionalProperties: false,
                    minProperties: 1,
                    properties: {
                        volume: { type: 'number', minimum: 0, maximum: 1 },
                        loop: { type: 'boolean' },
                        playOnAwake: { type: 'boolean' },
                        clip: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                id: { type: 'string', minLength: 1 },
                                type: { type: 'string', const: 'cc.AudioClip' },
                            },
                            required: ['id', 'type'],
                        },
                    },
                },
            },
            required: ['reference', 'properties'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                reference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                properties: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        volume: { type: 'number' },
                        loop: { type: 'boolean' },
                        playOnAwake: { type: 'boolean' },
                        clip: {
                            anyOf: [
                                { type: 'null' },
                                {
                                    type: 'object',
                                    additionalProperties: false,
                                    properties: { id: { type: 'string' }, type: { type: 'string', const: 'cc.AudioClip' } },
                                    required: ['id', 'type'],
                                },
                            ],
                        },
                    },
                    required: ['volume', 'loop', 'playOnAwake', 'clip'],
                },
                changed: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', enum: ['volume', 'loop', 'playOnAwake', 'clip'] } },
                verified: { type: 'boolean', const: true },
            },
            required: ['reference', 'componentReference', 'properties', 'changed', 'verified'],
        },
        'POST',
        ['audio', 'source', 'configure', 'mutation']
    )
    async audioSourceConfigure(args: {
        reference: IInstanceReference,
        properties: {
            volume?: number,
            loop?: boolean,
            playOnAwake?: boolean,
            clip?: IInstanceReference,
        },
    }): Promise<{
        reference: IInstanceReference,
        componentReference: IInstanceReference,
        properties: { volume: number, loop: boolean, playOnAwake: boolean, clip: IInstanceReference | null },
        changed: Array<'volume' | 'loop' | 'playOnAwake' | 'clip'>,
        verified: true,
    }> {
        const requested = args?.properties;
        const allowedKeys = ['volume', 'loop', 'playOnAwake', 'clip'] as const;
        const changed = requested && typeof requested === 'object' && !Array.isArray(requested)
            ? allowedKeys.filter((key) => Object.prototype.hasOwnProperty.call(requested, key))
            : [];
        if (!args?.reference?.id || !['cc.Node', 'cc.AudioSource'].includes(String(args.reference.type))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure requires a typed cc.Node or cc.AudioSource reference.' });
        }
        if (!requested || typeof requested !== 'object' || Array.isArray(requested) || changed.length === 0 || Object.keys(requested).some((key) => !allowedKeys.includes(key as typeof allowedKeys[number]))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure properties must contain at least one of volume, loop, playOnAwake, or clip and no other fields.' });
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'volume') && (typeof requested.volume !== 'number' || !Number.isFinite(requested.volume) || requested.volume < 0 || requested.volume > 1)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure volume must be a finite number between 0 and 1.' });
        }
        for (const key of ['loop', 'playOnAwake'] as const) {
            if (Object.prototype.hasOwnProperty.call(requested, key) && typeof requested[key] !== 'boolean') {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `audioSourceConfigure ${key} must be boolean.` });
            }
        }
        if (Object.prototype.hasOwnProperty.call(requested, 'clip')) {
            const clip = requested.clip;
            if (!clip || typeof clip !== 'object' || !clip.id || clip.type !== 'cc.AudioClip' || Object.keys(clip).some((key) => !['id', 'type'].includes(key))) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioSourceConfigure clip must be a typed cc.AudioClip asset reference.' });
            }
        }

        let node: NodeRecord | null;
        let source: ComponentRecord | undefined;
        if (args.reference.type === 'cc.Node') {
            node = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown as NodeRecord | null;
            if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource node ${args.reference.id} not found.` });
            const sources = (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource');
            if (sources.length === 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} has no cc.AudioSource component.` });
            if (sources.length > 1) throw new ToolError({ code: 'AMBIGUOUS_TARGET', status: 409, message: `Node ${args.reference.id} has multiple cc.AudioSource components; pass a component reference.` });
            source = sources[0];
        } else {
            const component = await Editor.Message.request('scene', 'query-component', args.reference.id) as unknown as ComponentRecord | null;
            if (!component) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource component ${args.reference.id} not found.` });
            if (componentType(component) !== 'cc.AudioSource') throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Component ${args.reference.id} is ${componentType(component) || 'unknown'}, not cc.AudioSource.` });
            const nodeUuid = referenceUuid(component.value?.node);
            if (!nodeUuid) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `AudioSource component ${args.reference.id} has no serialized node reference.` });
            node = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${nodeUuid} for AudioSource ${args.reference.id} not found.` });
            source = (node.__comps__ ?? []).find((candidate) => componentUuid(candidate) === args.reference.id);
            if (!source || componentType(source) !== 'cc.AudioSource') throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `AudioSource component ${args.reference.id} was not found on parent node ${nodeUuid}.` });
        }

        const nodeUuid = propertyValue(node.uuid);
        const sourceUuid = componentUuid(source);
        const sourceIndex = (node.__comps__ ?? []).indexOf(source);
        if (typeof nodeUuid !== 'string' || !nodeUuid || typeof sourceUuid !== 'string' || !sourceUuid || sourceIndex < 0) {
            throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: 'The target AudioSource does not expose stable serialized node and component UUIDs.' });
        }

        const expectedTypes: Record<typeof allowedKeys[number], string[]> = {
            volume: ['Float', 'Number', 'cc.Float', 'cc.Number'],
            loop: ['Boolean', 'cc.Boolean'],
            playOnAwake: ['Boolean', 'cc.Boolean'],
            clip: ['cc.AudioClip'],
        };
        const originals = new Map<typeof allowedKeys[number], IProperty>();
        for (const key of changed) {
            const dump = source.value?.[key];
            const type = dump && typeof dump === 'object' ? (dump as Record<string, unknown>).type : undefined;
            if (!dump || typeof dump !== 'object' || !('value' in dump) || typeof type !== 'string' || !expectedTypes[key].includes(type)) {
                throw new ToolError({
                    code: 'UNSUPPORTED_PROPERTY',
                    status: 422,
                    message: `AudioSource.${key} is unavailable or has an unsupported serialized type.`,
                    details: { property: key, actualType: type ?? null, expectedTypes: expectedTypes[key] },
                });
            }
            originals.set(key, cloneDump(dump as IProperty));
        }
        if (requested.clip) {
            const asset = await Editor.Message.request('asset-db', 'query-asset-info', requested.clip.id) as { type?: unknown } | null;
            if (!asset) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Audio clip asset ${requested.clip.id} not found.` });
            if (asset.type !== 'cc.AudioClip') {
                throw new ToolError({
                    code: 'TYPE_MISMATCH',
                    status: 422,
                    message: `Asset ${requested.clip.id} is ${asset.type || 'unknown'}, not cc.AudioClip.`,
                    details: { asset: requested.clip.id, expectedType: 'cc.AudioClip', actualType: asset.type ?? null },
                });
            }
        }

        const pathFor = (key: typeof allowedKeys[number]) => `__comps__.${sourceIndex}.${key}`;
        const requestedDump = (key: typeof allowedKeys[number]): IProperty => {
            const original = originals.get(key)!;
            const value = key === 'clip' ? { uuid: requested.clip!.id } : requested[key];
            return { ...original, value };
        };
        const attempted: Array<typeof allowedKeys[number]> = [];
        const currentSource = (dump: NodeRecord | null): ComponentRecord | undefined =>
            dump?.__comps__?.find((component) => componentUuid(component) === sourceUuid && componentType(component) === 'cc.AudioSource');
        const normalizedProperties = (component: ComponentRecord): { volume: number, loop: boolean, playOnAwake: boolean, clip: IInstanceReference | null } => {
            const clipUuid = referenceUuid(component.value?.clip);
            return {
                volume: propertyValue(component.value?.volume) as number,
                loop: propertyValue(component.value?.loop) as boolean,
                playOnAwake: propertyValue(component.value?.playOnAwake) as boolean,
                clip: clipUuid ? { id: clipUuid, type: 'cc.AudioClip' } : null,
            };
        };

        try {
            for (const key of changed) {
                attempted.push(key);
                const ok = await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: pathFor(key), dump: requestedDump(key) });
                if (ok === false) throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: `Creator refused AudioSource.${key} on ${nodeUuid}.` });
            }
            const snapshotResult = await Editor.Message.request('scene', 'snapshot') as unknown;
            if (snapshotResult === false) throw new ToolError({ code: 'MUTATION_FAILED', status: 500, message: `Creator refused AudioSource snapshot for ${nodeUuid}.` });
            const verifiedNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
            const verifiedSource = currentSource(verifiedNode);
            if (!verifiedSource) throw new ToolError({ code: 'POSTCONDITION_FAILED', status: 500, message: `AudioSource ${sourceUuid} was not found during read-back.` });
            const readback = normalizedProperties(verifiedSource);
            for (const key of changed) {
                const expected = key === 'clip' ? requested.clip!.id : requested[key];
                const actual = key === 'clip' ? readback.clip?.id : readback[key];
                if (actual !== expected) {
                    throw new ToolError({
                        code: 'POSTCONDITION_FAILED',
                        status: 500,
                        message: `AudioSource.${key} read-back did not match the requested value.`,
                        details: { property: key, expected, actual },
                    });
                }
            }
            return {
                reference: { id: nodeUuid, type: 'cc.Node' },
                componentReference: { id: sourceUuid, type: 'cc.AudioSource' },
                properties: readback,
                changed,
                verified: true,
            };
        } catch (error) {
            if (attempted.length > 0) {
                try {
                    const rollbackErrors: string[] = [];
                    for (const key of [...attempted].reverse()) {
                        try {
                            const ok = await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: pathFor(key), dump: originals.get(key)! });
                            if (ok === false) throw new Error(`Creator refused rollback of AudioSource.${key}`);
                        } catch (rollbackFieldError) {
                            rollbackErrors.push(rollbackFieldError instanceof Error ? rollbackFieldError.message : String(rollbackFieldError));
                        }
                    }
                    const rolledBackNode = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown as NodeRecord | null;
                    const rolledBackSource = currentSource(rolledBackNode);
                    if (!rolledBackSource || attempted.some((key) => !dumpsEqual(rolledBackSource.value?.[key], originals.get(key)))) {
                        rollbackErrors.push(`AudioSource ${sourceUuid} rollback read-back did not match the captured values`);
                    }
                    const rollbackSnapshot = await Editor.Message.request('scene', 'snapshot') as unknown;
                    if (rollbackSnapshot === false) rollbackErrors.push('Creator refused AudioSource rollback snapshot');
                    if (rollbackErrors.length > 0) throw new Error(rollbackErrors.join('; '));
                } catch (rollbackError) {
                    throw new ToolError({
                        code: 'ROLLBACK_FAILED',
                        status: 500,
                        message: `audioSourceConfigure failed and AudioSource ${sourceUuid} could not be rolled back.`,
                        details: {
                            cause: error instanceof Error ? error.message : String(error),
                            rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                            node: { id: nodeUuid, type: 'cc.Node' },
                            component: { id: sourceUuid, type: 'cc.AudioSource' },
                        },
                        recovery: `Inspect AudioSource ${sourceUuid} on node ${nodeUuid} and restore its serialized properties before retrying.`,
                    });
                }
            }
            if (error instanceof ToolError) throw error;
            throw new ToolError({
                code: 'MUTATION_FAILED',
                status: 500,
                message: `audioSourceConfigure failed for AudioSource ${sourceUuid}.`,
                details: { cause: error instanceof Error ? error.message : String(error) },
                recovery: 'The changed AudioSource properties were rolled back and verified; inspect the target before retrying.',
            });
        }
    }
    @utcpTool('audioSourceAudit', 'Audit bounded AudioSource clip and playback compatibility with normalized properties.', { type: 'object', properties: { reference: InstanceReferenceSchema } }, { type: 'object', properties: { valid: { type: 'boolean' }, sources: { type: 'array' }, issues: { type: 'array' }, checkedSources: { type: 'integer' } }, required: ['valid', 'sources', 'issues', 'checkedSources'] }, 'GET', ['audio', 'source', 'audit', 'compatibility'])
    async audioSourceAudit(args: { reference?: IInstanceReference }): Promise<{ valid: boolean, sources: Array<Record<string, unknown>>, issues: string[], checkedSources: number }> {
        const nodes = await sceneNodes(args.reference?.id);
        const issues: string[] = [];
        const sources = nodes.flatMap((node) => (node.__comps__ ?? []).filter((component) => componentType(component) === 'cc.AudioSource').map((component) => {
            const props = component.value ?? {};
            const clip = propertyValue(props.clip);
            const volume = propertyValue(props.volume);
            const loop = propertyValue(props.loop);
            const playOnAwake = propertyValue(props.playOnAwake);
            const name = nodeName(node);
            if (clip === null || clip === undefined || clip === '') issues.push(`${name}: missing clip`);
            if (typeof volume !== 'number' || volume < 0 || volume > 1) issues.push(`${name}: volume must be between 0 and 1`);
            return { node: { id: node.uuid, type: 'cc.Node' }, name, clip, volume, loop, playOnAwake };
        }));
        return { valid: issues.length === 0, sources, issues, checkedSources: sources.length };
    }

    @utcpTool('audioAssetValidate', 'Validate one audio asset importer/type and return bounded compatibility findings.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, importer: { type: 'string' }, type: { type: 'string' }, issues: { type: 'array' } }, required: ['valid', 'importer', 'type', 'issues'] }, 'GET', ['audio', 'asset', 'validate'])
    async audioAssetValidate(args: { reference: IInstanceReference }): Promise<{ valid: boolean, importer: string, type: string, issues: string[] }> {
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
        if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${args.reference.id} not found` });
        const issues: string[] = [];
        if (!/audio|clip|sound/i.test(String(info.type ?? '')) && !/audio|sound/i.test(String(info.importer ?? ''))) issues.push('asset importer/type is not recognized as audio');
        return { valid: issues.length === 0, importer: info.importer ?? '', type: info.type ?? '', issues };
    }

    @utcpTool(
        'audioAssetCompatibilityAudit',
        'Audit an explicit bounded list of typed cc.AudioClip assets against a declared web or native target. Uses only public asset metadata; it does not claim decode, duration, or playback success.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                assets: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 64,
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            id: { type: 'string', minLength: 1 },
                            type: { type: 'string', const: 'cc.AudioClip' },
                        },
                        required: ['id', 'type'],
                    },
                },
                target: { type: 'string', enum: [...AUDIO_TARGETS] },
                maxIssues: { type: 'integer', minimum: 1, maximum: 256, default: 256 },
            },
            required: ['assets', 'target'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                target: { type: 'string', enum: [...AUDIO_TARGETS] },
                valid: { type: 'boolean' },
                complete: { type: 'boolean' },
                items: { type: 'array', maxItems: 64, items: AUDIO_COMPAT_ITEM_SCHEMA },
                issues: { type: 'array', maxItems: 256, items: AUDIO_COMPAT_ISSUE_SCHEMA },
            },
            required: ['target', 'valid', 'complete', 'items', 'issues'],
        },
        'POST',
        ['audio', 'asset', 'compatibility', 'audit', 'target'],
    )
    async audioAssetCompatibilityAudit(args: {
        assets: IInstanceReference[];
        target: AudioTarget;
        maxIssues?: number;
    }): Promise<AudioCompatibilityAuditResult> {
        if (!Array.isArray(args?.assets) || args.assets.length < 1 || args.assets.length > 64 || typeof args?.target !== 'string' || !AUDIO_TARGETS.includes(args.target as AudioTarget)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'audioAssetCompatibilityAudit requires 1-64 typed cc.AudioClip references and one supported target.',
            });
        }
        if (args.assets.some((reference) => !reference || typeof reference !== 'object' || typeof reference.id !== 'string' || !reference.id || reference.type !== 'cc.AudioClip' || Object.keys(reference).some((key) => !['id', 'type'].includes(key)))) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'audioAssetCompatibilityAudit assets must be typed cc.AudioClip references with only id and type.',
            });
        }
        if (args.maxIssues !== undefined && (!Number.isInteger(args.maxIssues) || args.maxIssues < 1 || args.maxIssues > 256)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'audioAssetCompatibilityAudit maxIssues must be an integer from 1 to 256.' });
        }
        const entries = await Promise.all(args.assets.map(async (reference) => {
            try {
                const info = await Editor.Message.request('asset-db', 'query-asset-info', reference.id) as AudioAssetInfo | null;
                return { reference: { id: reference.id, type: 'cc.AudioClip' as const } satisfies AudioAssetReference, info };
            } catch (error) {
                throw new ToolError({
                    code: 'ASSET_QUERY_FAILED',
                    status: 502,
                    message: `Public asset database query failed for ${reference.id}.`,
                    details: { cause: error instanceof Error ? error.message : String(error) },
                    recovery: 'Retry after the Creator asset database is ready.',
                });
            }
        }));
        return buildAudioAssetCompatibilityAudit(args.target, entries, args.maxIssues);
    }
    @utcpTool('assetImporterAudit', 'Audit one asset importer with normalized source identity, settings and bounded compatibility findings.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, importer: { type: 'string' }, settings: { type: 'object' }, source: { type: 'object' }, issues: { type: 'array' } }, required: ['valid', 'importer', 'settings', 'source', 'issues'] }, 'GET', ['asset', 'importer', 'audit'])
    async assetImporterAudit(args: { reference: IInstanceReference }): Promise<{ valid: boolean, importer: string, settings: Record<string, unknown>, source: Record<string, unknown>, issues: string[] }> {
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', args.reference.id);
        if (!info) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset ${args.reference.id} not found` });
        const importer = String(info.importer ?? '');
        const settings = (info.importerSettings ?? info.meta ?? {}) as Record<string, unknown>;
        const source = { uuid: info.uuid, url: info.url, type: info.type, name: info.name, isDirectory: Boolean(info.isDirectory) };
        const issues: string[] = [];
        if (!importer) issues.push('asset has no importer');
        if (source.isDirectory) issues.push('asset reference resolves to a directory');
        return { valid: issues.length === 0, importer, settings, source, issues };
    }
    @utcpTool(
        'localizationValidate',
        'Validate 1-256 unique localization keys in the current Creator language through the fixed package scene seam.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                keys: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 256,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 1, maxLength: 256 },
                },
            },
            required: ['keys'],
        },
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                supported: { type: 'boolean' },
                language: { type: ['string', 'null'], minLength: 1, maxLength: 256 },
                checkedKeys: { type: 'integer', minimum: 0, maximum: 256 },
                missingKeys: {
                    type: 'array',
                    maxItems: 256,
                    uniqueItems: true,
                    items: { type: 'string', minLength: 1, maxLength: 256 },
                },
                error: { type: 'string', minLength: 1, maxLength: 512 },
            },
            required: ['supported', 'language', 'checkedKeys', 'missingKeys'],
            allOf: [{
                if: { properties: { supported: { const: false } }, required: ['supported'] },
                then: { required: ['error'] },
            }],
        },
        'GET',
        ['localization', 'validate', 'keys'],
    )
    async localizationValidate(args: { keys: string[] }): Promise<{ supported: boolean, language: string | null, checkedKeys: number, missingKeys: string[], error?: string }> {
        const input = args as unknown;
        const inputRecord = input && typeof input === 'object' && !Array.isArray(input)
            ? input as Record<string, unknown>
            : null;
        const keys = inputRecord?.keys;
        const inputKeys = inputRecord ? Object.keys(inputRecord) : [];
        if (!Array.isArray(keys)
            || keys.length < 1
            || keys.length > 256
            || inputKeys.length !== 1
            || inputKeys[0] !== 'keys') {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'localizationValidate requires only keys with 1-256 nonempty unique strings.',
            });
        }

        const uniqueKeys = new Set<string>();
        for (const key of keys) {
            if (typeof key !== 'string' || key.length < 1 || key.length > 256 || uniqueKeys.has(key)) {
                throw new ToolError({
                    code: 'INVALID_ARGUMENT',
                    status: 400,
                    message: 'localizationValidate keys must be nonempty unique strings of at most 256 characters.',
                });
            }
            uniqueKeys.add(key);
        }

        let raw: unknown;
        try {
            raw = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'validateLocalization',
                args: [keys],
            });
        } catch (error) {
            throw new ToolError({
                code: 'LOCALIZATION_VALIDATION_FAILED',
                status: 502,
                message: 'Creator scene transport failed while validating localization keys.',
                details: { cause: String(error instanceof Error ? error.message : error).slice(0, 512) },
                recovery: 'Retry after the Creator scene process and ccp3x package are ready.',
            });
        }

        if (!raw || typeof raw !== 'object' || Array.isArray(raw)
            || typeof (raw as Record<string, unknown>).supported !== 'boolean') {
            throw new ToolError({
                code: 'LOCALIZATION_INVALID_RESPONSE',
                status: 502,
                message: 'Creator localization validation returned an invalid response.',
                recovery: 'Retry with a compatible ccp3x scene package.',
            });
        }

        const response = raw as Record<string, unknown>;
        if (response.supported === false) {
            const reportedError = typeof response.error === 'string' ? response.error.trim() : '';
            return {
                supported: false,
                language: null,
                checkedKeys: 0,
                missingKeys: [],
                error: (reportedError || 'Creator localization package is unavailable.').slice(0, 512),
            };
        }

        const language = response.language;
        const checkedKeys = response.checkedKeys;
        const missingKeys = response.missingKeys;
        if ((language !== null && (typeof language !== 'string' || language.length < 1 || language.length > 256))
            || !Number.isInteger(checkedKeys)
            || checkedKeys !== keys.length
            || !Array.isArray(missingKeys)
            || missingKeys.some((key) => typeof key !== 'string' || !uniqueKeys.has(key))) {
            throw new ToolError({
                code: 'LOCALIZATION_INVALID_RESPONSE',
                status: 502,
                message: 'Creator localization validation returned an invalid response.',
                recovery: 'Retry with a compatible ccp3x scene package.',
            });
        }

        const missingSet = new Set(missingKeys as string[]);
        return {
            supported: true,
            language: language as string | null,
            checkedKeys: keys.length,
            missingKeys: keys.filter((key) => missingSet.has(key)),
        };
    }

    @utcpTool('buildPresetValidate', 'Validate bounded build options before dispatching a Creator build task.', { type: 'object', properties: { options: { type: 'object' } }, required: ['options'] }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, platform: { type: 'string' } }, required: ['valid', 'issues', 'platform'] }, 'POST', ['build', 'preset', 'validate'])
    async buildPresetValidate(args: { options: Record<string, unknown> }): Promise<{ valid: boolean, issues: string[], platform: string }> {
        const platform = typeof args.options.platform === 'string' ? args.options.platform : '';
        const issues: string[] = [];
        if (!platform) issues.push('options.platform is required');
        if (typeof args.options.buildPath === 'string' && args.options.buildPath.length > 512) issues.push('options.buildPath exceeds 512 characters');
        return { valid: issues.length === 0, issues, platform };
    }

    @utcpTool('buildArtifactInspect', 'Inspect a bounded project-local build artifact file inventory with byte sizes.', {
        type: 'object',
        additionalProperties: false,
        properties: {
            artifactPath: { type: 'string', minLength: 1 },
            maxFiles: { type: 'integer', minimum: 1, maximum: 256, default: 64 },
        },
        required: ['artifactPath'],
    }, {
        type: 'object',
        additionalProperties: false,
        properties: {
            exists: { type: 'boolean' },
            files: {
                type: 'array',
                maxItems: 256,
                items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        path: { type: 'string' },
                        bytes: { type: 'integer', minimum: 0 },
                    },
                    required: ['path', 'bytes'],
                },
            },
            count: { type: 'integer', minimum: 0, maximum: 256 },
            truncated: { type: 'boolean' },
        },
        required: ['exists', 'files', 'count', 'truncated'],
    }, 'GET', ['build', 'artifact', 'inspect'])
    async buildArtifactInspect(args: { artifactPath: string, maxFiles?: number }): Promise<{
        exists: boolean,
        files: Array<{ path: string, bytes: number }>,
        count: number,
        truncated: boolean,
    }> {
        const artifactPath = (args as { artifactPath?: unknown } | undefined)?.artifactPath;
        const maxFilesValue = (args as { maxFiles?: unknown } | undefined)?.maxFiles;
        if (typeof artifactPath !== 'string'
            || artifactPath.length === 0
            || /[\u0000-\u001f\u007f-\u009f]/u.test(artifactPath)
            || path.isAbsolute(artifactPath)
            || path.posix.isAbsolute(artifactPath)
            || path.win32.isAbsolute(artifactPath)
            || /^[A-Za-z]:/.test(artifactPath)
            || artifactPath.split(/[\\/]+/).some((segment) => segment === '..')) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'artifactPath must be a nonempty relative path without traversal or control characters',
            });
        }
        if (maxFilesValue !== undefined
            && (!Number.isInteger(maxFilesValue) || (maxFilesValue as number) < 1 || (maxFilesValue as number) > 256)) {
            throw new ToolError({
                code: 'INVALID_ARGUMENT',
                status: 400,
                message: 'maxFiles must be an integer between 1 and 256',
            });
        }
        const maxFiles = (maxFilesValue as number | undefined) ?? 64;
        const isWithinProject = (candidate: string, projectRoot: string): boolean => {
            const relative = path.relative(projectRoot, candidate);
            return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        };
        const isMissingError = (error: unknown): boolean => {
            const code = (error as { code?: unknown } | null)?.code;
            return code === 'ENOENT' || code === 'ENOTDIR';
        };
        const filesystemError = (operation: string, error: unknown): ToolError => new ToolError({
            code: 'BUILD_ARTIFACT_INSPECT_FAILED',
            status: 502,
            message: `Failed to ${operation} while inspecting the build artifact.`,
            details: { cause: (error instanceof Error ? error.message : String(error)).slice(0, 512) },
            recovery: 'Retry after the project filesystem is available.',
        });

        let projectRoot: string;
        try {
            projectRoot = await fs.realpath(path.resolve(Editor.Project.path));
        } catch (error) {
            throw filesystemError('resolve the project path', error);
        }
        const target = path.resolve(projectRoot, artifactPath);
        if (!isWithinProject(target, projectRoot)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        }

        let targetRealpath: string;
        try {
            targetRealpath = await fs.realpath(target);
        } catch (error) {
            if (isMissingError(error)) return { exists: false, files: [], count: 0, truncated: false };
            throw filesystemError('resolve the artifact path', error);
        }
        if (!isWithinProject(targetRealpath, projectRoot)) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        }

        const files: Array<{ path: string, bytes: number }> = [];
        const visitedDirectories = new Set<string>();
        let truncated = false;
        type FrontierEntry = { current: string, relative: string };
        const frontier: FrontierEntry[] = [{
            current: target,
            relative: path.relative(projectRoot, target).replace(/\\/g, '/'),
        }];
        const compareEntries = (left: FrontierEntry, right: FrontierEntry): number => {
            if (left.relative < right.relative) return -1;
            if (left.relative > right.relative) return 1;
            return left.current < right.current ? -1 : left.current > right.current ? 1 : 0;
        };
        const pushFrontier = (entry: FrontierEntry): void => {
            frontier.push(entry);
            let index = frontier.length - 1;
            while (index > 0) {
                const parent = Math.floor((index - 1) / 2);
                if (compareEntries(frontier[parent], entry) <= 0) break;
                frontier[index] = frontier[parent];
                index = parent;
            }
            frontier[index] = entry;
        };
        const popFrontier = (): FrontierEntry | undefined => {
            const first = frontier[0];
            const last = frontier.pop();
            if (!first || !last || frontier.length === 0) return first;
            let index = 0;
            while (true) {
                const left = index * 2 + 1;
                if (left >= frontier.length) break;
                const right = left + 1;
                const child = right < frontier.length && compareEntries(frontier[right], frontier[left]) < 0 ? right : left;
                if (compareEntries(frontier[child], last) >= 0) break;
                frontier[index] = frontier[child];
                index = child;
            }
            frontier[index] = last;
            return first;
        };

        while (frontier.length > 0) {
            const next = popFrontier();
            if (!next) break;
            let realCurrent: string;
            try {
                realCurrent = await fs.realpath(next.current);
            } catch (error) {
                throw filesystemError('resolve an artifact entry', error);
            }
            if (!isWithinProject(realCurrent, projectRoot)) {
                throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
            }
            let currentStat: { isDirectory(): boolean, size: number };
            try {
                currentStat = await fs.stat(next.current);
            } catch (error) {
                throw filesystemError('read an artifact entry', error);
            }
            if (!currentStat.isDirectory()) {
                if (files.length >= maxFiles) {
                    truncated = true;
                    break;
                }
                files.push({ path: next.relative, bytes: currentStat.size });
                continue;
            }
            if (visitedDirectories.has(realCurrent)) continue;
            visitedDirectories.add(realCurrent);
            let entries: string[];
            try {
                entries = await fs.readdir(next.current);
            } catch (error) {
                throw filesystemError('read an artifact directory', error);
            }
            for (const entry of entries) {
                const current = path.join(next.current, entry);
                pushFrontier({
                    current,
                    relative: path.relative(projectRoot, current).replace(/\\/g, '/'),
                });
            }
        }
        return { exists: true, files, count: files.length, truncated };
    }
    @utcpTool('buildOutputAudit', 'Verify bounded build output files, byte sizes and SHA-256 hashes against an expected manifest.', {
        type: 'object',
        properties: {
            artifactPath: { type: 'string' },
            expectedFiles: { type: 'array', maxItems: 256, items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$' } }, required: ['path'] } },
        },
        required: ['artifactPath', 'expectedFiles'],
    }, { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array' }, files: { type: 'array' }, checkedFiles: { type: 'integer' } }, required: ['valid', 'issues', 'files', 'checkedFiles'] }, 'GET', ['build', 'output', 'audit', 'hash'])
    async buildOutputAudit(args: { artifactPath: string, expectedFiles: Array<{ path: string, sha256?: string }> }): Promise<{ valid: boolean, issues: string[], files: Array<Record<string, unknown>>, checkedFiles: number }> {
        const projectRoot = path.resolve((Editor.Project as any).path);
        const artifactRoot = path.resolve(projectRoot, args.artifactPath);
        const artifactRelative = path.relative(projectRoot, artifactRoot);
        if (artifactRelative.startsWith('..') || path.isAbsolute(artifactRelative)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'artifactPath must remain inside the project' });
        const issues: string[] = [];
        const files: Array<Record<string, unknown>> = [];
        for (const expected of args.expectedFiles.slice(0, 256)) {
            const target = path.resolve(artifactRoot, expected.path);
            const targetRelative = path.relative(artifactRoot, target);
            if (targetRelative.startsWith('..') || path.isAbsolute(targetRelative)) {
                issues.push(`outside-artifact:${expected.path}`);
                continue;
            }
            const stat = await fs.stat(target).catch(() => null);
            if (!stat?.isFile()) {
                issues.push(`missing:${expected.path}`);
                continue;
            }
            const sha256 = await hashFile(target);
            const row = { path: path.relative(projectRoot, target).replace(/\\/g, '/'), bytes: stat.size, sha256 };
            files.push(row);
            if (expected.sha256 && expected.sha256.toLowerCase() !== sha256) issues.push(`hash-mismatch:${expected.path}`);
        }
        return { valid: issues.length === 0 && files.length === args.expectedFiles.slice(0, 256).length, issues, files, checkedFiles: files.length };
    }
}
