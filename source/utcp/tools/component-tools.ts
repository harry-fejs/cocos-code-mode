import { createHash } from 'crypto';
import packageJSON from '../../../package.json';
import { utcpTool } from '../decorators';
import { SuccessIndicatorSchema, ISuccessIndicator, InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
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
        'Inspect exact component identities on one node; optional single class or OR class list and bounded offset/limit. Entire inventory validates before filtering/paging; pages are observations, not atomic snapshots.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                componentReference: InstanceReferenceSchema,
                componentType: { type: 'string', minLength: 1, maxLength: 256 },
                componentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
                offset: { type: 'integer', minimum: 0, maximum: 10000 },
                enabled: { type: 'boolean', description: 'Exact serialized component enabled flag; not runtime activation.' },
                requireSingle: { type: 'boolean', default: false, description: 'Require exactly one complete filtered match before pagination; offset must be0.' },
                limit: { type: 'integer', minimum: 1, maximum: 1000 },
                expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Revision from a previous page; refuses changed inventory or class selectors.' },
            },
            required: ['reference']
        },
        { type: 'object', properties: { references: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, componentIndex: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' } }, required: ['id', 'componentIndex'] } }, inventorySummary: { type: 'object', properties: { total: { type: 'integer' }, enabled: { type: 'integer' }, disabled: { type: 'integer' }, unknownEnabled: { type: 'integer' }, classCounts: { type: 'object', additionalProperties: { type: 'integer', minimum: 1 } } }, required: ['total', 'enabled', 'disabled', 'unknownEnabled', 'classCounts'] }, total: { type: 'integer' }, offset: { type: 'integer' }, nextOffset: { type: ['integer', 'null'] }, truncated: { type: 'boolean' }, revision: { type: 'string' } }, required: ['references', 'inventorySummary', 'total', 'offset', 'nextOffset', 'truncated', 'revision'] }, 'GET', ['scene', 'node', 'component', 'get', 'inspection']
    )
    async nodeComponentsGet(args: { reference: IInstanceReference, componentReference?: IInstanceReference, componentType?: string, componentTypes?: string[], enabled?: boolean, requireSingle?: boolean, offset?: number, limit?: number, expectedRevision?: string }): Promise<{ references: Array<IInstanceReference & { componentIndex: number, enabled?: boolean }>, inventorySummary: { total: number, enabled: number, disabled: number, unknownEnabled: number, classCounts: Record<string, number> }, total: number, offset: number, nextOffset: number | null, truncated: boolean, revision: string }> {
        if (args.expectedRevision !== undefined && (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'expectedRevision requires a SHA256 revision token.' });
        if (args.componentReference !== undefined && (typeof args.componentReference?.id !== 'string' || !args.componentReference.id.trim() || args.componentReference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentReference requires a bounded exact component UUID.' });
        if (args.componentType !== undefined && args.componentTypes !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Choose componentType or componentTypes, not both.' });
        const types = args.componentTypes ?? (args.componentType !== undefined ? [args.componentType] : undefined);
        if (types !== undefined && (!Array.isArray(types) || types.length < 1 || types.length > 32 || types.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Component class selectors require1..32 bounded names.' });
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'enabled must be a boolean serialized component selector.' });
        const offset = args.offset ?? 0;
        if (!Number.isInteger(offset) || offset < 0 || offset > 10000 || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offset must be0..10000 and limit1..1000.' });
        if (args.requireSingle !== undefined && typeof args.requireSingle !== 'boolean' || args.requireSingle === true && offset !== 0) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'requireSingle must be boolean and requires offset0.' });
        const selectedTypes = types ? new Set(types.map(type => type.replace(/^cc\./, ''))) : undefined;
        if (!args.reference?.id) throw new Error('nodeComponentsGet requires reference.id');
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!node) throw new Error(`Node ${args.reference.id} not found`);
        const nodeUuid = field(node, 'uuid');
        if ((typeof nodeUuid === 'string' ? nodeUuid : field(nodeUuid, 'value')) !== args.reference.id) throw new Error('nodeComponentsGet: node UUID read-back does not match the requested target');

        if (!Array.isArray(node.__comps__)) throw new Error(`nodeComponentsGet: node ${args.reference.id} lacks a serialized component array — dump shape drift`);
        const components = node.__comps__;
        if (components.length > VERBOSE_TREE_NODES) throw new Error('nodeComponentsGet: serialized component inventory exceeds the inspection budget');
        const identities = new Set<string>();
        const foundComponents: Array<IInstanceReference & { componentIndex: number, enabled?: boolean }> = [];
        const inventory: Array<{ id: string, type: string, enabled?: boolean }> = [];
        const inventorySummary = { total: components.length, enabled: 0, disabled: 0, unknownEnabled: 0, classCounts: Object.create(null) as Record<string, number> };
        for (const [componentIndex, comp] of components.entries()) {
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
            inventorySummary.classCounts[declaredType] = (inventorySummary.classCounts[declaredType] ?? 0) + 1;
            const enabledField = field(comp, 'enabled') ?? field(value, 'enabled');
            const rawEnabled = typeof enabledField === 'boolean' ? enabledField : field(enabledField, 'value');
            if (rawEnabled === true) inventorySummary.enabled++;
            else if (rawEnabled === false) inventorySummary.disabled++;
            else inventorySummary.unknownEnabled++;
            if (args.enabled !== undefined && typeof rawEnabled !== 'boolean') throw new ToolError({ code: 'COMPONENT_STATE_UNAVAILABLE', status: 422, message: 'Serialized enabled state is unavailable; no enabled-filtered result returned.' });
            inventory.push({ id: compUuid, type: declaredType, ...(typeof rawEnabled === 'boolean' ? { enabled: rawEnabled } : {}) });
            if ((args.componentReference === undefined || compUuid === args.componentReference.id) && (!selectedTypes || selectedTypes.has(declaredType.replace(/^cc\./, ''))) && (args.enabled === undefined || rawEnabled === args.enabled)) {
                foundComponents.push({ id: compUuid, type: declaredType, componentIndex, ...(typeof rawEnabled === 'boolean' ? { enabled: rawEnabled } : {}) });
            }
        }

        const revision = createHash('sha256').update(JSON.stringify({ node: args.reference.id, inventory, selector: { componentId: args.componentReference?.id ?? null, types: args.componentType !== undefined ? ['single', args.componentType.replace(/^cc\./, '')] : selectedTypes ? ['multi', [...selectedTypes].sort()] : ['all'], enabled: args.enabled ?? null } })).digest('hex');
        if (args.expectedRevision !== undefined && args.expectedRevision !== revision) throw new ToolError({ code: 'COMPONENT_INVENTORY_CHANGED', status: 409, message: 'Component inventory or selector changed; restart pagination from a fresh observation.' });
        if (args.componentReference !== undefined && !identities.has(args.componentReference.id)) throw new ToolError({ code: 'COMPONENT_NOT_ATTACHED', status: 404, message: 'The exact component UUID is not attached to the requested node.' });
        if (args.requireSingle && foundComponents.length !== 1) throw new ToolError({ code: foundComponents.length ? 'COMPONENT_MATCH_AMBIGUOUS' : 'COMPONENT_MATCH_NOT_FOUND', status: foundComponents.length ? 409 : 404, message: 'Single-component lookup requires exactly one filtered match.', details: { nodeId: args.reference.id, matchCount: foundComponents.length } });
        if (!foundComponents.length && args.componentType) throw new Error(`Components of type ${args.componentType} not found on node ${args.reference.id}`);
        if (offset > foundComponents.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'offset exceeds the observed filtered inventory.' });
        const references = foundComponents.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
        const next = offset + references.length;
        return { references, inventorySummary, total: foundComponents.length, offset, nextOffset: next < foundComponents.length ? next : null, truncated: next < foundComponents.length, revision };
    }

    @utcpTool(
        'nodeComponentsBatchGet',
        'Inspect component inventories on1..32 exact nodes sequentially with per-item errors. Class selectors use OR; each result carries its own revision. No writes or atomic cross-node snapshot.',
        { type: 'object', additionalProperties: false, properties: {
            references: { type: 'array', minItems: 1, maxItems: 32, items: InstanceReferenceSchema },
            componentTypes: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 256 } },
            enabled: { type: 'boolean', description: 'Exact serialized enabled selector shared by every node.' },
            limitPerNode: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
        }, required: ['references'] },
        { type: 'object', properties: { items: { type: 'array' }, succeeded: { type: 'integer' }, failed: { type: 'integer' }, truncated: { type: 'boolean' }, inventorySummary: { type: 'object', properties: { observedNodes: { type: 'integer' }, failedNodes: { type: 'integer' }, total: { type: 'integer' }, enabled: { type: 'integer' }, disabled: { type: 'integer' }, unknownEnabled: { type: 'integer' } }, required: ['observedNodes', 'failedNodes', 'total', 'enabled', 'disabled', 'unknownEnabled'] } }, required: ['items', 'succeeded', 'failed', 'truncated', 'inventorySummary'] },
        'GET', ['scene', 'node', 'component', 'batch', 'inspection']
    )
    async nodeComponentsBatchGet(args: { references: IInstanceReference[], componentTypes?: string[], enabled?: boolean, limitPerNode?: number }): Promise<{ items: Array<Record<string, unknown>>, succeeded: number, failed: number, truncated: boolean, inventorySummary: { observedNodes: number, failedNodes: number, total: number, enabled: number, disabled: number, unknownEnabled: number } }> {
        if (args.enabled !== undefined && typeof args.enabled !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'enabled must be a boolean serialized component selector.' });
        if (!Array.isArray(args?.references) || args.references.length < 1 || args.references.length > 32 || args.references.some(reference => typeof reference?.id !== 'string' || !reference.id.trim() || reference.id.length > 256)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'references requires1..32 bounded node UUIDs.' });
        if (args.componentTypes !== undefined && (!Array.isArray(args.componentTypes) || args.componentTypes.length < 1 || args.componentTypes.length > 32 || args.componentTypes.some(type => typeof type !== 'string' || !type.trim() || type.length > 256))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'componentTypes requires1..32 bounded class names.' });
        const limit = args.limitPerNode ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'limitPerNode must be1..100.' });
        const references = args.references.map(reference => ({ id: reference.id }));
        if (new Set(references.map(reference => reference.id)).size !== references.length) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Batch node UUIDs must be unique to avoid double-counting inventory.' });
        const componentTypes = args.componentTypes?.slice();
        const items: Array<Record<string, unknown>> = [];
        let succeeded = 0, truncated = false;
        const inventorySummary = { observedNodes: 0, failedNodes: 0, total: 0, enabled: 0, disabled: 0, unknownEnabled: 0 };
        for (const [index, reference] of references.entries()) {
            try {
                const result = await this.nodeComponentsGet({ reference, componentTypes, enabled: args.enabled, limit });
                items.push({ index, ok: true, reference, result });
                succeeded++;
                truncated ||= result.truncated;
                inventorySummary.observedNodes++;
                inventorySummary.total += result.inventorySummary.total;
                inventorySummary.enabled += result.inventorySummary.enabled;
                inventorySummary.disabled += result.inventorySummary.disabled;
                inventorySummary.unknownEnabled += result.inventorySummary.unknownEnabled;
            } catch (error) {
                inventorySummary.failedNodes++;
                items.push({ index, ok: false, reference, error: { code: error instanceof ToolError ? error.code : 'COMPONENT_QUERY_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 512) } });
            }
        }
        return { items, succeeded, failed: references.length - succeeded, truncated, inventorySummary };
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
                const remainingUuid = field(remaining, 'uuid') ?? field(field(remaining, 'value'), 'uuid');
                throw new Error(`Component ${args.reference.id} still exists after removal (read-back ${String(remainingUuid ?? 'unknown')})`);
            }
            await Editor.Message.request('scene', 'snapshot');
            return { success: true };
        } catch (error: unknown) {
            throw new Error(`Failed to remove component ${args.reference.id}. Reason: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async nodeComponentAdd(args: { reference: IInstanceReference, componentType: string }): Promise<{ reference: IInstanceReference }> {
        if (!args.reference?.id || typeof args.componentType !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(args.componentType)) throw new Error('nodeComponentAdd requires a bounded component class identifier.');
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!node) throw new Error(`Node ${args.reference.id} not found`);
        const checkedComponents = (dump: unknown): unknown[] => {
            const uuid = field(dump, 'uuid');
            const components = field(dump, '__comps__');
            if ((typeof uuid === 'string' ? uuid : field(uuid, 'value')) !== args.reference.id || !Array.isArray(components) || components.length > VERBOSE_TREE_NODES) {
                throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component add node identity or bounded inventory could not be confirmed.', details: { nodeId: args.reference.id, retrySafe: false }, recovery: 'Inspect the exact node inventory before another mutation.' });
            }
            const identities = new Set<string>();
            for (const component of components) {
                const id = componentUuid(component);
                const type = componentType(component);
                if (!id?.trim() || !type?.trim() || identities.has(id)) throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component add inventory contains missing or duplicate identities.', details: { nodeId: args.reference.id, retrySafe: false }, recovery: 'Inspect the complete node inventory before another mutation.' });
                identities.add(id);
            }
            return components;
        };

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
        const existingUuids = new Set<string>(checkedComponents(node).map(componentUuid).filter((id): id is string => !!id));

        await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'startCatchLogging', args: [] });
        let caughtLogs: string[] = [];
        try {
            try {
                await Editor.Message.request('scene', 'create-component', { uuid: args.reference.id, component: args.componentType });
            } catch (error) {
                throw new ToolError({ code: 'COMPONENT_CREATE_OUTCOME_UNKNOWN', status: 502, message: 'Component creation dispatch failed; the mutation outcome must be reconciled.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false, cause: error instanceof Error ? error.message : String(error) }, recovery: 'Inspect the exact node component inventory before another creation attempt; do not replay this mutation automatically.' });
            }
            caughtLogs = await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [] }) ?? [];
        } catch (error) {
            let cleanupFailed = false;
            try { await Editor.Message.request('scene', 'execute-scene-script', { name: packageJSON.name, method: 'stopCatchLogging', args: [] }); }
            catch { cleanupFailed = true; }
            if (error instanceof ToolError && error.code === 'COMPONENT_CREATE_OUTCOME_UNKNOWN') {
                throw new ToolError({ code: error.code, status: error.status, message: error.message, details: { ...error.details, loggingCleanupFailed: cleanupFailed }, recovery: error.recovery });
            }
            throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Component creation returned but logging completion failed; component state is unverified.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false, loggingCleanupFailed: cleanupFailed }, recovery: 'Inspect the node component inventory before retrying; the component may already exist.' });
        }

        const nodeAfter = await Editor.Message.request('scene', 'query-node', args.reference.id);
        if (!nodeAfter) throw new Error(`nodeComponentAdd: node ${args.reference.id} disappeared after create-component`);
        const newComponents = checkedComponents(nodeAfter).filter((component: unknown) => {
            const id = componentUuid(component);
            return !!id && !existingUuids.has(id) && componentType(component) === args.componentType;
        });
        if (newComponents.length > 1) throw new ToolError({ code: 'COMPONENT_CREATE_AMBIGUOUS', status: 409, message: 'Multiple new components match the requested class; creation identity is ambiguous.', details: { nodeId: args.reference.id, componentType: args.componentType, retrySafe: false }, recovery: 'Inspect the exact node inventory; do not retry creation or remove unowned components automatically.' });
        const newComponent = newComponents[0];
        const newId = componentUuid(newComponent);
        if (!newId) throw new Error(`Failed to add component. Captured logs: ${caughtLogs.join('\n')}`);

        await Editor.Message.request('scene', 'snapshot');
        const verifiedNode = await Editor.Message.request('scene', 'query-node', args.reference.id);
        const verifiedMatches = checkedComponents(verifiedNode).filter((component: unknown) => componentUuid(component) === newId);
        if (verifiedMatches.length !== 1 || componentType(verifiedMatches[0]) !== args.componentType) throw new ToolError({ code: 'COMPONENT_CREATE_POSTCONDITION_UNKNOWN', status: 502, message: 'Added component UUID/type was not uniquely confirmed after snapshot.', details: { nodeId: args.reference.id, componentId: newId, componentType: args.componentType, retrySafe: false }, recovery: 'Inspect the node inventory before any further mutation.' });
        return { reference: { id: newId, type: args.componentType } };
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
