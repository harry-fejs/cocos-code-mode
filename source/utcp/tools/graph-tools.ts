import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { captureCurrentSceneGraph } from '../graph-live';
import { resolveProjectGraphCache, runGraphWorker } from '../graph-runtime';

type GraphOperation = 'status' | 'build' | 'query' | 'resolve' | 'navigate' | 'refs' | 'validate';
type GraphInput = {
    operation: GraphOperation;
    bundle?: string;
    refresh?: boolean;
    source?: 'disk' | 'auto';
    text?: string;
    byComponent?: string;
    byScript?: string;
    componentUuid?: string;
    pathGlob?: string;
    explain?: boolean;
    handle?: string;
    uuid?: string;
    relation?: 'ancestors' | 'children' | 'descendants';
    depth?: number;
    assetUuid?: string;
    limit?: number;
    cursor?: number;
};

const graphHandle = {
    type: 'object', additionalProperties: false,
    properties: {
        handle: { type: 'string', minLength: 1, maxLength: 2048 },
        uuid: { type: 'string', minLength: 1, maxLength: 256 },
        path: { type: 'string', maxLength: 2048 },
        name: { type: 'string', maxLength: 512 },
        file: { type: 'string', minLength: 1, maxLength: 2048 },
        source: { type: 'string', enum: ['disk', 'live'] },
        bundle: { type: 'string', minLength: 1, maxLength: 128 },
        reason: { type: 'string', maxLength: 256 },
    }, required: ['handle', 'uuid', 'path', 'name', 'file', 'source', 'bundle'],
};
const stale = {
    type: 'object', additionalProperties: false,
    properties: {
        age_ms: { type: 'number' }, dirty: { type: ['boolean', 'string'] }, advisory: { type: 'boolean' }, prefabOpaque: { type: 'boolean' },
    }, required: ['age_ms', 'dirty', 'advisory', 'prefabOpaque'],
};
const page = {
    type: 'object', additionalProperties: false,
    properties: {
        total: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' }, cursor: { type: ['integer', 'null'], minimum: 0 },
    }, required: ['total', 'truncated', 'cursor'],
};
const shard = {
    type: 'object', additionalProperties: false,
    properties: {
        name: { type: 'string' }, source: { type: 'string' }, files: { type: 'integer' }, bytes: { type: 'integer' }, nodes: { type: 'integer' },
        builtAt: { type: ['integer', 'null'] }, ageMs: { type: ['integer', 'null'] }, dirty: { type: ['boolean', 'string'] },
        prefabOpaque: { type: 'boolean' }, graphAvailable: { type: 'boolean' },
    }, required: ['name', 'source', 'files', 'bytes', 'builtAt', 'ageMs', 'dirty', 'prefabOpaque', 'graphAvailable'],
};
const output: any = {
    type: 'object', additionalProperties: false,
    properties: {
        operation: { type: 'string', enum: ['status', 'build', 'query', 'resolve', 'navigate', 'refs', 'validate'] },
        cacheRoot: { type: 'string' }, built: { type: 'boolean' }, parserVersion: { type: ['string', 'null'] }, supported: { type: 'boolean' },
        stale: { anyOf: [stale, { type: 'boolean' }] }, shards: { type: 'array', maxItems: 64, items: shard }, totalShards: { type: 'integer' },
        source: { type: 'string', enum: ['disk', 'mixed', 'live', 'empty'] }, liveOverlay: { type: 'object', additionalProperties: false, properties: { applied: { type: 'boolean' }, reason: { type: ['string', 'null'] }, sourceFile: { type: ['string', 'null'] }, dirty: { type: ['boolean', 'null'] }, nodes: { type: ['integer', 'null'] } }, required: ['applied', 'reason', 'sourceFile', 'dirty', 'nodes'] },
        total: { type: 'integer', minimum: 0 }, truncated: { type: 'boolean' }, cursor: { type: ['integer', 'null'], minimum: 0 }, handles: { type: 'array', maxItems: 200, items: graphHandle },
        status: { type: 'string', enum: ['resolved', 'not_found', 'ambiguous'] }, node: graphHandle, candidates: { type: 'array', maxItems: 200, items: graphHandle }, relation: { type: 'string', enum: ['ancestors', 'children', 'descendants'] },
        refs: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, properties: { node: { type: 'string' }, nodeUuid: { type: 'string' }, file: { type: 'string' }, source: { type: 'string' }, uuid: { type: 'string' }, prop: { type: 'string' }, bundle: { type: 'string' } }, required: ['node', 'nodeUuid', 'file', 'source', 'uuid', 'prop', 'bundle'] } },
        valid: { type: 'boolean' }, bundle: { type: 'string' }, components: { type: 'integer' }, references: { type: 'integer' },
    }, required: ['operation'],
};

function invalid(message: string): never {
    throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message });
}

export class GraphTools {
    @utcpTool('graphManage', 'Build, inspect, and query the active Cocos project structural graph. Graph identity and hierarchy are T0/T1 evidence only; always verify the same target through live CCP tools before any mutation.', {
        type: 'object', additionalProperties: false,
        properties: {
            operation: { type: 'string', enum: ['status', 'build', 'query', 'resolve', 'navigate', 'refs', 'validate'] },
            bundle: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\\\/]+$' },
            refresh: { type: 'boolean', default: false },
            source: { type: 'string', enum: ['disk', 'auto'], default: 'disk' },
            text: { type: 'string', minLength: 1, maxLength: 256 },
            byComponent: { type: 'string', minLength: 1, maxLength: 256 },
            byScript: { type: 'string', minLength: 1, maxLength: 256 },
            componentUuid: { type: 'string', minLength: 1, maxLength: 256 },
            pathGlob: { type: 'string', minLength: 1, maxLength: 2048 },
            explain: { type: 'boolean', default: false },
            handle: { type: 'string', minLength: 1, maxLength: 2048 },
            uuid: { type: 'string', minLength: 1, maxLength: 256 },
            relation: { type: 'string', enum: ['ancestors', 'children', 'descendants'] },
            depth: { type: 'integer', minimum: 1, maximum: 32, default: 1 },
            assetUuid: { type: 'string', minLength: 1, maxLength: 256 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            cursor: { type: 'integer', minimum: 0, maximum: 10000000, default: 0 },
        }, required: ['operation'],
        allOf: [
            { if: { properties: { operation: { const: 'build' } }, required: ['operation'] }, then: { properties: { source: { enum: ['disk', 'auto'] } } } },
            { if: { properties: { source: { const: 'auto' } }, required: ['source'] }, then: { required: ['bundle'] } },
            { if: { properties: { operation: { enum: ['query', 'resolve', 'navigate', 'refs', 'validate'] } }, required: ['operation'] }, then: { required: ['bundle'] } },
            { if: { properties: { operation: { const: 'resolve' } }, required: ['operation'] }, then: { oneOf: [{ required: ['handle'], not: { required: ['uuid'] } }, { required: ['uuid'], not: { required: ['handle'] } }] } },
            { if: { properties: { operation: { const: 'navigate' } }, required: ['operation'] }, then: { required: ['handle', 'relation'] } },
            { if: { properties: { operation: { const: 'refs' } }, required: ['operation'] }, then: { required: ['assetUuid'] } },
        ],
    }, output, 'POST', ['graph', 'scene', 'asset', 'structure', 'query', 'resolve', 'navigate', 'references', 'validate'])
    async graphManage(args: GraphInput): Promise<Record<string, unknown>> {
        if (!args || typeof args !== 'object') invalid('graphManage requires an operation object.');
        const allowed = new Set(['operation', 'bundle', 'refresh', 'source', 'text', 'byComponent', 'byScript', 'componentUuid', 'pathGlob', 'explain', 'handle', 'uuid', 'relation', 'depth', 'assetUuid', 'limit', 'cursor']);
        for (const key of Object.keys(args)) if (!allowed.has(key)) invalid(`Unknown graphManage argument: ${key}.`);
        const operation = args.operation;
        if (!['status', 'build', 'query', 'resolve', 'navigate', 'refs', 'validate'].includes(operation)) invalid('operation must be status, build, query, resolve, navigate, refs, or validate.');
        const bundle = args.bundle;
        if (bundle !== undefined && (typeof bundle !== 'string' || bundle.length < 1 || bundle.length > 128 || bundle === '.' || bundle === '..' || /[\\/]/.test(bundle))) invalid('bundle must be a top-level assets bundle name without path separators.');
        if (operation !== 'status' && operation !== 'build' && !bundle) invalid(`${operation} requires bundle.`);
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') invalid('refresh must be boolean.');
        if (args.source !== undefined && !['disk', 'auto'].includes(args.source)) invalid('source must be disk or auto.');
        if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 200)) invalid('limit must be an integer from 1 to 200.');
        if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 0 || args.cursor > 10000000)) invalid('cursor must be a non-negative integer no greater than 10000000.');
        if (args.depth !== undefined && (!Number.isInteger(args.depth) || args.depth < 1 || args.depth > 32)) invalid('depth must be an integer from 1 to 32.');
        if (operation === 'resolve' && Boolean(args.handle) === Boolean(args.uuid)) invalid('resolve requires exactly one of handle or uuid.');
        if (operation === 'navigate' && (!args.handle || !args.relation)) invalid('navigate requires handle and relation.');
        if (operation === 'refs' && !args.assetUuid) invalid('refs requires assetUuid.');
        if (args.source === 'auto' && operation !== 'build') invalid('source=auto is only valid for build.');

        let cache: { project: string, outDir: string };
        try { cache = resolveProjectGraphCache(Editor.Project?.path); }
        catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'GRAPH_PATH_INVALID', status: 400, message: 'Could not resolve the active Creator project graph cache.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }

        let liveSnapshot: Record<string, unknown> | null = null;
        let liveBundle: string | null = null;
        if (operation === 'build' && args.source === 'auto') {
            const live = await captureCurrentSceneGraph(cache.project, bundle);
            liveBundle = live.bundle;
            liveSnapshot = live.snapshot;
        }
        const input: Record<string, unknown> = {
            ...cache, bundle: liveBundle ?? bundle, refresh: args.refresh ?? false, source: args.source ?? 'disk',
            liveSnapshot,
            query: { byComponent: args.byComponent, byScript: args.byScript, componentUuid: args.componentUuid, pathGlob: args.pathGlob, text: args.text, explain: args.explain ?? false, limit: args.limit ?? 50, cursor: args.cursor ?? 0 },
            locator: { handle: args.handle, uuid: args.uuid },
            navigation: { handle: args.handle, relation: args.relation, depth: args.depth ?? 1, limit: args.limit ?? 50, cursor: args.cursor ?? 0 },
            assetUuid: args.assetUuid,
        };
        const result = await runGraphWorker(operation, { ...input, project: cache.project, outDir: cache.outDir }) as Record<string, unknown>;
        if (operation === 'build') {
            const overlay = args.source === 'auto'
                ? { applied: !!liveSnapshot, reason: liveSnapshot ? null : 'NO_ACTIVE_SCENE', sourceFile: liveSnapshot?.sourceFile ?? null, dirty: liveSnapshot?.dirty ?? null, nodes: liveSnapshot?.capturedNodes ?? null }
                : { applied: false, reason: 'DISK_SOURCE', sourceFile: null, dirty: null, nodes: null };
            return { operation, ...result, liveOverlay: overlay };
        }
        return { operation, ...result };
    }
}
