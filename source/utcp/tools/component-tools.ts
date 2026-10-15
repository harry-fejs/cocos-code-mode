import packageJSON from '../../../package.json';
import { utcpTool } from '../decorators';
import { SuccessIndicatorSchema, ISuccessIndicator, InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { VERBOSE_TREE_NODES } from '../utils/verbose';

function field(value: unknown, key: string): unknown {
    return value && typeof value === 'object' && key in value
        ? (value as Record<string, unknown>)[key]
        : undefined;
}

function nestedField(value: unknown, parent: string, key: string): unknown {
    return field(field(value, parent), key);
}

export class ComponentTools {

    @utcpTool(
        'nodeGetAvailableComponentTypes',
        'Get list of globally available component types (class names) at the moment.',
        {
            type: 'object',
            properties: {
                includeInternal: { type: 'boolean', default: false, description: 'Whether to include internal engine components.' },
                filter: { type: 'string', description: 'Optional filter string to match component types or categories (case-insensitive substring match).' },
                limit: { type: 'integer', minimum: 1, maximum: 1000, default: 200, description: 'Maximum component types to return.' }
            }
        },
        { type: 'object', properties: { componentTypes: { type: 'array', items: { type: 'string' } }, total: { type: 'number' }, truncated: { type: 'boolean' } }, required: ['componentTypes', 'total', 'truncated'] }, "GET",  ['scene', 'node', 'component', 'types', 'inspection']
    )
    async nodeGetAvailableComponentTypes(args: { includeInternal?: boolean, filter?: string, limit?: number } = {}): Promise<{ componentTypes: string[], total: number, truncated: boolean }> {
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) throw new Error('Component discovery limit must be an integer from 1 to 1000.');
        if (args.filter !== undefined && typeof args.filter !== 'string') throw new Error('Component discovery filter must be a string.');
        if (args.includeInternal !== undefined && typeof args.includeInternal !== 'boolean') throw new Error('includeInternal must be a boolean.');
        const allComponents = await Editor.Message.request('scene', 'query-components');

        if (!Array.isArray(allComponents)) {
            throw new Error('Failed to retrieve component types');
        }
        for (const component of allComponents) {
            if (!component || typeof component !== 'object' || Array.isArray(component)
                || typeof component.name !== 'string' || !component.name.trim()
                || ('type' in component && (typeof component.type !== 'string' || !component.type.trim()))
                || (component.assetUuid !== undefined && component.assetUuid !== null && typeof component.assetUuid !== 'string')) {
                throw new Error('Component registry contains malformed class metadata.');
            }
        }

        const lowerFilter = args.filter ? args.filter.toLowerCase() : null;
        const filtered = allComponents.filter((comp: any) => {
            let matchesFilter = true;
            if (lowerFilter) {
                matchesFilter = (comp.type ?? comp.name).toLowerCase().includes(lowerFilter);
            }
            if (!args.includeInternal) {
                matchesFilter = matchesFilter && comp.assetUuid && comp.assetUuid.length > 0;
            }
            return matchesFilter;
        });

        const names = filtered.map((comp: any) => comp.name).filter((name: any) => typeof name === 'string');
        const limit = Math.min(Math.max(args.limit ?? 200, 1), 1000);

        return { componentTypes: names.slice(0, limit), total: names.length, truncated: names.length > limit };
    }

    @utcpTool(
        'nodeComponentsGet',
        'Get components of specific type on a node. If componentType is not provided, returns all components on the node.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                componentType: { type: 'string' }
            },
            required: ['reference']
        },
        { type: 'object', properties: { references: { type: 'array', items: InstanceReferenceSchema } }, required: ['references'] }, "GET",  ['scene', 'node', 'component', 'get', 'inspection']
    )
    async nodeComponentsGet(args: { reference: IInstanceReference, componentType?: string }): Promise<{ references: IInstanceReference[] }> {
        if (!args.reference?.id) throw new Error('nodeComponentsGet requires reference.id');
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!node) throw new Error(`Node ${args.reference.id} not found`);
        const nodeUuid = field(node, 'uuid');
        if ((typeof nodeUuid === 'string' ? nodeUuid : field(nodeUuid, 'value')) !== args.reference.id) throw new Error('nodeComponentsGet: node UUID read-back does not match the requested target');

        if (!Array.isArray(node.__comps__)) throw new Error(`nodeComponentsGet: node ${args.reference.id} lacks a serialized component array — dump shape drift`);
        const components = node.__comps__;
        if (components.length > VERBOSE_TREE_NODES) throw new Error('nodeComponentsGet: serialized component inventory exceeds the inspection budget');
        const identities = new Set<string>();
        const foundComponents: IInstanceReference[] = [];
        for (const comp of components) {
            const value = field(comp, 'value');
            const uuidValue = field(value, 'uuid');
            const nestedUuid = field(uuidValue, 'value');
            const rawType = field(comp, 'type')
                ?? nestedField(value, '__type__', 'value') ?? field(value, '__type__')
                ?? field(comp, 'cid') ?? field(value, 'cid');
            const compUuid = typeof uuidValue === 'string'
                ? uuidValue
                : typeof nestedUuid === 'string' ? nestedUuid : field(comp, 'uuid');
            const declaredType = typeof rawType === 'string' ? rawType : undefined;
            if (typeof compUuid !== 'string' || !compUuid.trim() || !declaredType?.trim()) {
                throw new Error(`nodeComponentsGet: component on ${args.reference.id} lacks authoritative uuid/type — dump shape drift`);
            }
            if (identities.has(compUuid)) throw new Error('nodeComponentsGet: duplicate component UUID in serialized inventory');
            identities.add(compUuid);

            if (!args.componentType || (declaredType && (
                declaredType === args.componentType
                || declaredType === `cc.${args.componentType}`
                || declaredType.replace(/^cc\\./, '') === args.componentType.replace(/^cc\\./, '')
            ))) {
                foundComponents.push({ id: compUuid, type: declaredType });
            }
        }

        if (foundComponents.length > 0 || !args.componentType) return { references: foundComponents };
        throw new Error(`Components of type ${args.componentType} not found on node ${args.reference.id}`);
    }

    async nodeComponentRemove(args: { reference: IInstanceReference }): Promise<ISuccessIndicator> {
        if (!args.reference?.id) throw new Error('nodeComponentRemove requires reference.id');
        try {
            const component = await Editor.Message.request('scene', 'query-component', args.reference.id);
            if (component === null || component === undefined) {
                throw new Error(`Component ${args.reference.id} not found`);
            }

            await Editor.Message.request('scene', 'remove-component', { uuid: args.reference.id });
            const remaining = await Editor.Message.request('scene', 'query-component', args.reference.id);
            if (remaining !== null && remaining !== undefined) {
                throw new Error(`Component ${args.reference.id} still exists after removal`);
            }
            return { success: true };
        } catch (error: unknown) {
            throw new Error(`Failed to remove component ${args.reference.id}. Reason: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async nodeComponentAdd(args: { reference: IInstanceReference, componentType: string }): Promise<{ reference: IInstanceReference }> {
        if (!args.reference?.id || typeof args.componentType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(args.componentType)) throw new Error('nodeComponentAdd requires a bounded component class identifier.');
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!node) throw new Error(`Node ${args.reference.id} not found`);

        const componentUuid = (component: unknown): string | undefined => {
            if (!component || typeof component !== 'object') return undefined;
            const row = component as Record<string, unknown>;
            const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
            const uuid = value?.uuid;
            if (typeof uuid === 'string') return uuid;
            if (uuid && typeof uuid === 'object' && typeof (uuid as Record<string, unknown>).value === 'string') return (uuid as Record<string, unknown>).value as string;
            return typeof row.uuid === 'string' ? row.uuid : undefined;
        };
        const componentType = (component: unknown): string | undefined => {
            if (!component || typeof component !== 'object') return undefined;
            const row = component as Record<string, unknown>;
            if (typeof row.type === 'string') return row.type;
            const value = row.value && typeof row.value === 'object' ? row.value as Record<string, unknown> : undefined;
            const declared = value?.__type__;
            if (typeof declared === 'string') return declared;
            if (declared && typeof declared === 'object' && typeof (declared as Record<string, unknown>).value === 'string') return (declared as Record<string, unknown>).value as string;
            return typeof row.cid === 'string' ? row.cid : typeof value?.cid === 'string' ? value.cid : undefined;
        };
        const existingUuids = new Set<string>((node.__comps__ ?? []).map(componentUuid).filter((id: string | undefined): id is string => !!id));

        await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'startCatchLogging', args: [] });
        let caughtLogs: string[] = [];
        try {
            await Editor.Message.request('scene', 'create-component', { uuid: args.reference.id, component: args.componentType });
            caughtLogs = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [] }) ?? [];
        } catch (error) {
            await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [] }).catch(() => undefined);
            throw error;
        }

        const nodeAfter = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!nodeAfter) throw new Error(`nodeComponentAdd: node ${args.reference.id} disappeared after create-component`);
        const newComponent = (nodeAfter.__comps__ ?? []).find((component: unknown) => {
            const id = componentUuid(component);
            return !!id && !existingUuids.has(id) && componentType(component) === args.componentType;
        });
        const newId = componentUuid(newComponent);
        if (!newId) throw new Error(`Failed to add component. Captured logs: ${caughtLogs.join('\n')}`);

        await Editor.Message.request('scene', 'snapshot');
        const verifiedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
        const verified = (verifiedNode?.__comps__ ?? []).find((component: unknown) => componentUuid(component) === newId);
        if (!verified) throw new Error(`Component ${newId} was not present after add read-back`);
        return { reference: { id: newId, type: componentType(verified) ?? args.componentType } };
    }

    @utcpTool(
        'addComponent',
        'Alias for bounded node component creation with authoritative UUID/type read-back.',
        { type: 'object', properties: { reference: InstanceReferenceSchema, componentType: { type: 'string' } }, required: ['reference', 'componentType'] },
        { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] },
        'POST', ['scene', 'node', 'component', 'add']
    )
    async addComponent(args: { reference: IInstanceReference, componentType: string }): Promise<{ reference: IInstanceReference }> {
        return this.nodeComponentAdd(args);
    }
}
