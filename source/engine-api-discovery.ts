import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ToolError } from './utcp/tool-error';
import { IInstanceReference } from './utcp/schemas';
import { ToolsUtils } from './utcp/utils/tools-utils';
import { z } from './schema-validator';
import type { infer as InferSchema } from 'zod';

export interface EngineDiscoveryArgs {
    category?: string; className?: string; targetVersion?: string; domain?: string;
    filter?: string; reference?: IInstanceReference; maxEntries?: number; maxBytes?: number; cursor?: string;
}
const ApiRecordSchema = z.object({ id: z.string().min(1), className: z.string().nullable().optional(), namespace: z.string(), member: z.string().nullable().optional(), name: z.string().optional(), kind: z.string().optional(), signatures: z.array(z.unknown()).optional() }).passthrough();
type ApiRecord = InferSchema<typeof ApiRecordSchema>;
const CatalogIndexSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), catalogHash: z.string().regex(/^[a-f0-9]{64}$/), domains: z.array(z.object({ name: z.string(), file: z.string(), count: z.number().int().nonnegative() })).max(1000) });
const CursorSchema = z.object({ hash: z.string(), selector: z.string(), offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const CATALOG_ROOT = path.join(__dirname, 'engine-api-catalog');
const VERSIONS: Record<string, true> = { '3.7.3': true, '3.8.8': true };
const MAX_CATALOG_FILE = 8 * 1024 * 1024;
function jsonFile(file: string): unknown {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_CATALOG_FILE) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Catalog input exceeds its bound.' });
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function limit(value: number | undefined, fallback: number, maximum: number): number {
    const selected = value ?? fallback;
    if (!Number.isInteger(selected) || selected < 1 || selected > maximum) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Catalog limit must be an integer from 1 to ${maximum}.` });
    return selected;
}

export async function discoverEngineApi(args: EngineDiscoveryArgs): Promise<Record<string, unknown>> {
    const version = args.targetVersion ?? '3.7.3';
    if (!Object.prototype.hasOwnProperty.call(VERSIONS, version)) throw new ToolError({ code: 'UNSUPPORTED_VERSION', status: 422, message: 'Only catalogued versions 3.7.3 and 3.8.8 are available.' });
    if (args.category === 'component_schema' && !args.className) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'component_schema requires className.' });
    const maxEntries = limit(args.maxEntries, 50, 200), maxBytes = limit(args.maxBytes, 32768, 131072);
    const indexPath = path.join(CATALOG_ROOT, version, 'index.json');
    if (!fs.existsSync(indexPath)) throw new ToolError({ code: 'CATALOG_UNAVAILABLE', status: 422, message: `No installed catalog for ${version}.` });
    const index = CatalogIndexSchema.parse(jsonFile(indexPath));
    if (index.version !== version) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed catalog identity is invalid.' });
    const selector = JSON.stringify({ version, domain: args.domain ?? '', filter: args.filter ?? '', className: args.className ?? '' });
    const selectorHash = crypto.createHash('sha256').update(selector).digest('hex');
    let offset = 0;
    if (args.cursor) {
        try {
            if (!/^[A-Za-z0-9_-]{1,2048}$/.test(args.cursor)) throw new Error();
            const cursor = CursorSchema.parse(JSON.parse(Buffer.from(args.cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')));
            if (cursor.hash !== index.catalogHash || cursor.selector !== selectorHash) throw new Error();
            offset = cursor.offset;
        } catch { throw new ToolError({ code: 'STALE_CURSOR', status: 409, message: 'Catalog cursor does not match this version/filter/snapshot.' }); }
    }
    const records: ApiRecord[] = [];
    for (const domain of index.domains) {
        if (args.domain && domain.name !== args.domain) continue;
        if (path.basename(domain.file) !== domain.file) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Unsafe catalog shard path.' });
        const shard = z.object({ records: z.array(ApiRecordSchema).max(10000) }).parse(jsonFile(path.join(CATALOG_ROOT, version, domain.file)));
        for (const record of shard.records) {
            if (record.namespace === 'editor-ipc') continue;
            if (args.className && (record.className ?? '').replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) continue;
            if (args.filter && !`${record.className ?? ''}.${record.member ?? record.name ?? ''}`.toLowerCase().includes(args.filter.toLowerCase())) continue;
            records.push({ ...record, permitted: false, writablePath: null, evidenceStatus: 'declared' });
        }
    }
    records.sort((a, b) => a.id.localeCompare(b.id));
    if (args.className && records.length === 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Class ${args.className} is absent from the ${version} catalog.` });
    let live: Record<string, unknown> = { checked: false, context: 'edit-scene', available: null, writablePaths: [], mutationAuthorized: false };
    if (args.className && version === '3.7.3' && !args.reference) {
        try {
            const availability = z.object({ available: z.boolean(), className: z.string(), engineVersion: z.string().nullable(), context: z.literal('edit-scene') }).parse(await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'engineApiClassAvailability', args: [{ className: args.className }] }));
            live = { ...live, ...availability, checked: true, versionMatches: availability.engineVersion === version };
        } catch (error: unknown) {
            live = { ...live, unavailableReason: error instanceof Error ? error.message.slice(0, 256) : 'Class availability probe unavailable' };
        }
    }
    if (args.reference) {
        if (version !== '3.7.3') throw new ToolError({ code: 'VERSION_CONTEXT_MISMATCH', status: 422, message: 'Comparison catalog cannot be mapped to the Creator3.7 target.' });
        // Re-read every request: project script recompilation cannot leave a persistent path cache.
        const info = await ToolsUtils.inspectInstance(args.reference.id, false);
        if (!info?.props) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Target has no authoritative Inspector dump.' });
        if (args.className && info.type.replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: 'Target class does not match requested catalog class.' });
        live = { checked: true, context: 'edit-scene', available: true, type: info.type, writablePaths: Object.entries(info.props).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value) && 'readonly' in value && value.readonly === false).map(([key]) => key), mutationAuthorized: false, pathEvidence: 'authoritative-inspector-dump' };
    }
    const selected: ApiRecord[] = [];
    const cursorAt = (next: number): string | null => next < records.length ? Buffer.from(JSON.stringify({ hash: index.catalogHash, selector: selectorHash, offset: next })).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    const result = (): Record<string, unknown> => ({ version, catalogHash: index.catalogHash, records: selected, total: records.length, count: selected.length, truncated: offset + selected.length < records.length, nextCursor: cursorAt(offset + selected.length), live, runtimeVerified: false, qualified: false });
    if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Required catalog metadata exceeds maxBytes.' });
    for (const record of records.slice(offset, offset + maxEntries)) {
        selected.push(record);
        if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) { selected.pop(); break; }
    }
    if (offset < records.length && selected.length === 0) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'One catalog record cannot fit maxBytes; narrow the query or increase its explicit bound.' });
    return result();
}
