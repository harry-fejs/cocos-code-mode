import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { AssetTools } from './asset-tools';
import { ToolsUtils } from '../utils/tools-utils';

const MAX_BATCH_READ_ENTRIES = 100;
const MAX_BATCH_FIELDS = 100;
const MAX_ASSET_QUERY_LIMIT = 200;
const SCENE_BATCH_TARGETS = ['instance', 'CurrentSceneGlobals', 'ProjectSettings'];

type SceneBatchEntry = {
    reference?: IInstanceReference,
    target?: 'instance' | 'CurrentSceneGlobals' | 'ProjectSettings',
    fields?: string[],
};

type AssetBatchQuery = {
    name?: string,
    pattern?: string,
    ccType?: string,
    importer?: string,
    extname?: string,
    isBundle?: boolean,
    limit?: number,
};

function validateFields(fields: unknown, label: string): void {
    if (fields === undefined) return;
    if (!Array.isArray(fields) || fields.length > MAX_BATCH_FIELDS || !fields.every((field) => typeof field === 'string' && field.length > 0)) {
        throw new Error(`${label} must contain at most ${MAX_BATCH_FIELDS} non-empty strings`);
    }
}

function validateSceneBatchEntry(entry: unknown, index: number, inheritedFields: unknown): void {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`sceneBatchGet entry ${index + 1} must be an object`);
    }

    const candidate = entry as { reference?: unknown, target?: unknown, fields?: unknown };
    const target = candidate.target ?? 'instance';
    if (typeof target !== 'string' || !SCENE_BATCH_TARGETS.includes(target)) {
        throw new Error(`sceneBatchGet entry ${index + 1} has an invalid target`);
    }
    if (target === 'instance') {
        const reference = candidate.reference as { id?: unknown } | undefined;
        if (!reference || typeof reference.id !== 'string' || !reference.id) {
            throw new Error(`sceneBatchGet entry ${index + 1} with target "instance" requires reference.id`);
        }
    }
    validateFields(candidate.fields, `sceneBatchGet entry ${index + 1} fields`);
    validateFields(inheritedFields, 'sceneBatchGet fields');
}

function validateAssetBatchQuery(query: unknown, index: number): void {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
        throw new Error(`assetBatchQuery query ${index + 1} must be an object`);
    }

    const candidate = query as { name?: unknown, pattern?: unknown, ccType?: unknown, importer?: unknown, extname?: unknown, isBundle?: unknown, limit?: unknown };
    const stringFilters = [candidate.name, candidate.pattern, candidate.ccType, candidate.importer, candidate.extname];
    if (stringFilters.some((filter) => filter !== undefined && (typeof filter !== 'string' || filter.length === 0))) {
        throw new Error(`assetBatchQuery query ${index + 1} filters must be non-empty strings`);
    }
    if (candidate.isBundle !== undefined && typeof candidate.isBundle !== 'boolean') {
        throw new Error(`assetBatchQuery query ${index + 1} isBundle must be a boolean`);
    }
    const hasStringFilter = stringFilters.some((filter) => typeof filter === 'string');
    if (!hasStringFilter && typeof candidate.isBundle !== 'boolean') {
        throw new Error(`assetBatchQuery query ${index + 1} requires at least one filter`);
    }
    if (candidate.limit !== undefined && (typeof candidate.limit !== 'number' || !Number.isInteger(candidate.limit) || candidate.limit < 1)) {
        throw new Error(`assetBatchQuery query ${index + 1} limit must be a positive integer`);
    }
}

// M2 — Batch property reads as 1 HTTP tool instead of N individual GETs.
// Cargo cult N HTTP == N*N round trips; batch tool collapses to 1.
export class BatchReadTools {

    @utcpTool(
        'sceneBatchGet',
        'Batch inspectorGet across 1-100 nodes or settings targets. Instance targets require reference; globals and project settings do not. Field lists are capped at 100 items.',
        {
            type: 'object',
            properties: {
                entries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_BATCH_READ_ENTRIES,
                    items: {
                        type: 'object',
                        properties: {
                            reference: InstanceReferenceSchema,
                            target: { type: 'string', enum: SCENE_BATCH_TARGETS, description: 'Where to read from (default instance)' },
                            fields: { type: 'array', maxItems: MAX_BATCH_FIELDS, items: { type: 'string', minLength: 1 }, description: `Field filter applied to each dump (maximum ${MAX_BATCH_FIELDS})` },
                        },
                        anyOf: [
                            { required: ['reference'] },
                            { properties: { target: { type: 'string', enum: ['CurrentSceneGlobals', 'ProjectSettings'] } }, required: ['target'] },
                        ],
                    },
                    description: `Array of 1-${MAX_BATCH_READ_ENTRIES} inspector targets`,
                },
                fields: { type: 'array', maxItems: MAX_BATCH_FIELDS, items: { type: 'string', minLength: 1 }, description: `Field filter applied to every entry if entry.fields is absent (maximum ${MAX_BATCH_FIELDS})` },
            },
            required: ['entries'],
        },
        { type: 'object', properties: { results: { type: 'array', maxItems: MAX_BATCH_READ_ENTRIES, items: { type: 'object' } } }, required: ['results'] },
        'POST',
        ['batch', 'read', 'inspector', 'scene', 'dump', 'multi']
    )
    async sceneBatchGet(args: { entries: SceneBatchEntry[], fields?: string[] }): Promise<{ results: Array<{ reference: IInstanceReference, dump: unknown } | { reference: IInstanceReference, error: string }> }> {
        if (!Array.isArray(args.entries) || args.entries.length === 0 || args.entries.length > MAX_BATCH_READ_ENTRIES) {
            throw new Error(`sceneBatchGet requires 1-${MAX_BATCH_READ_ENTRIES} entries`);
        }
        validateFields(args.fields, 'sceneBatchGet fields');
        const entriesArr = args.entries;
        entriesArr.forEach((entry, index) => validateSceneBatchEntry(entry, index, args.fields));

        const settled = await Promise.allSettled(entriesArr.map(async (entry) => {
            const target = entry.target ?? 'instance';
            const id = target === 'instance' ? entry.reference?.id : target;
            if (!id) throw new Error('instance requires reference.id');
            const info = await ToolsUtils.inspectInstance(id);
            if (!info) throw new Error(`Target ${id} not found`);
            if (!info.props) throw new Error(`No properties for ${id}`);
            let props = info.props;
            const fields = entry.fields ?? args.fields;
            if (fields?.length) {
                const filtered: typeof props = {};
                for (const field of fields) if (field in props) filtered[field] = props[field];
                props = filtered;
            }
            return {
                reference: entry.reference ?? { id, type: target },
                dump: ToolsUtils.unwrapProperties(props),
            };
        }));

        const results = settled.map((result, index) => {
            if (result.status === 'fulfilled') return result.value;
            const entry = entriesArr[index];
            const target = entry.target ?? 'instance';
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            return { reference: entry.reference ?? { id: target, type: target }, error: reason };
        });
        return { results };
    }

    @utcpTool(
        'assetBatchQuery',
        'Batch 1-100 filtered asset queries. Each query needs a filter; each explicit limit is capped at 200 results.',
        {
            type: 'object',
            properties: {
                queries: {
                    type: 'array',
                    minItems: 1,
                    maxItems: MAX_BATCH_READ_ENTRIES,
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', minLength: 1 },
                            pattern: { type: 'string', minLength: 1 },
                            ccType: { type: 'string', minLength: 1 },
                            importer: { type: 'string', minLength: 1 },
                            extname: { type: 'string', minLength: 1 },
                            isBundle: { type: 'boolean' },
                            limit: { type: 'integer', minimum: 1, maximum: MAX_ASSET_QUERY_LIMIT, description: `Per-query result cap (maximum ${MAX_ASSET_QUERY_LIMIT})` },
                        },
                        anyOf: [
                            { required: ['name'] },
                            { required: ['pattern'] },
                            { required: ['ccType'] },
                            { required: ['importer'] },
                            { required: ['extname'] },
                            { required: ['isBundle'] },
                        ],
                    },
                    description: `Array of 1-${MAX_BATCH_READ_ENTRIES} filtered asset queries`,
                },
            },
            required: ['queries'],
        },
        { type: 'object', properties: { results: { type: 'array', maxItems: MAX_BATCH_READ_ENTRIES, items: { type: 'object' } } }, required: ['results'] },
        'POST',
        ['batch', 'asset', 'query', 'multi', 'bulk']
    )
    async assetBatchQuery(args: { queries: AssetBatchQuery[] }): Promise<{ results: unknown[] }> {
        if (!Array.isArray(args.queries) || args.queries.length === 0 || args.queries.length > MAX_BATCH_READ_ENTRIES) {
            throw new Error(`assetBatchQuery requires 1-${MAX_BATCH_READ_ENTRIES} queries`);
        }
        const queriesArr = args.queries;
        queriesArr.forEach((query, index) => validateAssetBatchQuery(query, index));
        const tool = new AssetTools();
        const results = await Promise.all(queriesArr.map((query) => tool.assetQuery(
            query.limit === undefined ? query : { ...query, limit: Math.min(query.limit, MAX_ASSET_QUERY_LIMIT) }
        )));
        return { results };
    }
}
