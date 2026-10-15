import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { ToolError } from './utcp/tool-error';
import { IInstanceReference } from './utcp/schemas';
import { ToolsUtils } from './utcp/utils/tools-utils';
import { z } from './schema-validator';
import type { infer as InferSchema } from 'zod';
import { openExternalApiCatalog } from './external-api-catalog';

export interface EngineDiscoveryArgs {
    category?: string; className?: string; targetVersion?: string; domain?: string;
    operation?: 'records' | 'list_domains' | 'list_classes' | 'list_namespaces' | 'list_members' | 'get_signature' | 'compare_version';
    namespace?: 'engine-runtime' | 'engine-authoring' | 'editor-ipc' | 'bridge';
    filter?: string; recordId?: string; compareVersion?: string; compareRecordId?: string; reference?: IInstanceReference; maxEntries?: number; maxBytes?: number; cursor?: string;
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
    const operation = args.operation ?? 'records';
    if (!['records', 'list_domains', 'list_classes', 'list_namespaces', 'list_members', 'get_signature', 'compare_version'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Unknown catalog discovery operation.' });
    if (operation === 'compare_version') {
        if (!args.compareVersion || args.compareVersion === version || !Object.prototype.hasOwnProperty.call(VERSIONS, args.compareVersion)
            || typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024
            || typeof args.compareRecordId !== 'string' || !args.compareRecordId || args.compareRecordId.length > 1024
            || args.reference || args.className || args.domain || args.namespace || args.filter || args.cursor || args.category === 'component_schema') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'compare_version requires distinct catalog versions and two exact record IDs without live targets, filters or cursors.' });
        limit(args.maxEntries, 50, 200);
        const maxBytes = limit(args.maxBytes, 32768, 131072);
        const before = await discoverEngineApi({ targetVersion: version, recordId: args.recordId, maxEntries: 1, maxBytes: 131072 });
        const after = await discoverEngineApi({ targetVersion: args.compareVersion, recordId: args.compareRecordId, maxEntries: 1, maxBytes: 131072 });
        const left = (before.records as ApiRecord[])[0], right = (after.records as ApiRecord[])[0];
        if (typeof left.semanticKey !== 'string' || !left.semanticKey || left.semanticKey !== right.semanticKey) throw new ToolError({ code: 'CATALOG_IDENTITY_MISMATCH', status: 409, message: 'Selected records do not prove the same version-independent semantic identity.' });
        const compareHash = (field: string): 'unchanged' | 'changed' | 'unknown' => {
            const a = left[field], b = right[field];
            return typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && typeof b === 'string' && /^[a-f0-9]{64}$/.test(b) ? a === b ? 'unchanged' : 'changed' : 'unknown';
        };
        const result = { version, operation, semanticKey: left.semanticKey,
            before: { version, recordId: left.id, catalogHash: before.catalogHash, coverage: before.coverage },
            after: { version: args.compareVersion, recordId: right.id, catalogHash: after.catalogHash, coverage: after.coverage },
            comparison: { signatures: compareHash('signatureHash'), metadata: compareHash('metadataHash'), resolution: compareHash('resolutionHash') },
            permitted: false, mutationAuthorized: false, runtimeVerified: false, qualified: false };
        if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Exact catalog comparison exceeds maxBytes.' });
        return result;
    }
    if (args.compareVersion !== undefined || args.compareRecordId !== undefined) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Comparison selectors require compare_version.' });
    if (operation !== 'records' && operation !== 'get_signature' && (args.reference || args.recordId || args.category === 'component_schema' || args.className && !['list_members'].includes(operation))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Catalog navigation does not accept an instance, record or class schema target.' });
    if (operation === 'get_signature' && (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'get_signature requires a bounded exact recordId.' });
    if (args.recordId !== undefined && (typeof args.recordId !== 'string' || !args.recordId || args.recordId.length > 1024 || !['records', 'get_signature'].includes(operation))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'recordId requires records or get_signature operation and a bounded nonempty identity.' });
    const maxEntries = limit(args.maxEntries, 50, 200), maxBytes = limit(args.maxBytes, 32768, 131072);
    const external = openExternalApiCatalog(version);
    const indexPath = path.join(CATALOG_ROOT, version, 'index.json');
    if (!external && !fs.existsSync(indexPath)) throw new ToolError({ code: 'CATALOG_UNAVAILABLE', status: 422, message: `No installed catalog for ${version}.` });
    const index = external ?? CatalogIndexSchema.parse(jsonFile(indexPath));
    if (!external && 'version' in index && index.version !== version) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Installed catalog identity is invalid.' });
    const provenancePath = path.join(CATALOG_ROOT, version, 'provenance.json');
    const provenance = !external && fs.existsSync(provenancePath) ? z.object({ scope: z.string().optional(), originalCatalogHash: z.string().nullable().optional() }).passthrough().parse(jsonFile(provenancePath)) : null;
    const coverage = { scope: external ? 'operator-configured-full-catalog' : provenance?.scope ?? 'installed-catalog-scope-unverified', fullCatalogLoaded: external !== null, originalCatalogHash: external?.catalogHash ?? provenance?.originalCatalogHash ?? null };
    const selector = JSON.stringify({ version, operation, namespace: args.namespace ?? '', domain: args.domain ?? '', filter: args.filter ?? '', className: args.className ?? '', recordId: args.recordId ?? '' });
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
    if (external && operation !== 'list_domains') {
        for (const entry of external.entries) {
            if (args.recordId !== undefined && entry.id !== args.recordId) continue;
            if (args.domain && entry.domain !== args.domain) continue;
            if (args.namespace && entry.namespace !== args.namespace) continue;
            if (args.category === 'component_schema' && entry.namespace !== 'engine-runtime') continue;
            if (args.className && (entry.className ?? '').replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) continue;
            if (args.filter && !`${entry.className ?? ''}.${entry.member ?? entry.name}`.toLowerCase().includes(args.filter.toLowerCase())) continue;
            records.push({ id: entry.id, namespace: entry.namespace, className: entry.className, member: entry.member, name: entry.name, kind: entry.kind });
        }
    }
    for (const domain of operation === 'list_domains' || external ? [] : index.domains) {
        if (args.domain && domain.name !== args.domain) continue;
        if (path.basename(domain.file) !== domain.file) throw new ToolError({ code: 'CATALOG_INVALID', status: 502, message: 'Unsafe catalog shard path.' });
        const shard = z.object({ records: z.array(ApiRecordSchema).max(10000) }).parse(jsonFile(path.join(CATALOG_ROOT, version, domain.file)));
        for (const record of shard.records) {
            if (args.recordId !== undefined && record.id !== args.recordId) continue;
            if (args.namespace && record.namespace !== args.namespace) continue;
            if (args.category === 'component_schema' && record.namespace !== 'engine-runtime') continue;
            if (args.className && (record.className ?? '').replace(/^cc\./, '') !== args.className.replace(/^cc\./, '')) continue;
            if (args.filter && !`${record.className ?? ''}.${record.member ?? record.name ?? ''}`.toLowerCase().includes(args.filter.toLowerCase())) continue;
            records.push({ ...record, permitted: false, writablePath: null, evidenceStatus: 'declared' });
        }
    }
    records.sort((a, b) => a.id.localeCompare(b.id));
    if (operation === 'list_domains') {
        const domains = new Map<string, number>();
        for (const shard of index.domains) {
            if (args.domain && shard.name !== args.domain) continue;
            if (args.namespace && !shard.name.startsWith(`${args.namespace}.`)) continue;
            if (args.filter && !shard.name.toLowerCase().includes(args.filter.toLowerCase())) continue;
            domains.set(shard.name, (domains.get(shard.name) ?? 0) + shard.count);
        }
        for (const [name, recordCount] of [...domains].sort(([a], [b]) => a.localeCompare(b))) records.push({ id: `${version}:domain:${name}`, namespace: name.split('.')[0], kind: 'domain', name, recordCount, permitted: false });
    } else if (operation === 'list_classes') {
        const classes = new Map<string, ApiRecord>();
        for (const record of records) {
            if (!record.className) continue;
            const key = `${record.namespace}:${record.className}`;
            const existing = classes.get(key);
            if (existing) existing.recordCount = Number(existing.recordCount) + 1;
            else classes.set(key, { id: `${version}:class-index:${key}`, namespace: record.namespace, className: record.className, name: record.className, kind: 'class-summary', recordCount: 1, permitted: false });
        }
        records.splice(0, records.length, ...[...classes.values()].sort((a, b) => a.id.localeCompare(b.id)));
    } else if (operation === 'list_namespaces') {
        const namespaces = new Map<string, number>();
        for (const record of records) namespaces.set(record.namespace, (namespaces.get(record.namespace) ?? 0) + 1);
        records.splice(0, records.length, ...[...namespaces].sort(([a], [b]) => a.localeCompare(b)).map(([namespace, recordCount]) => ({ id: `${version}:namespace:${namespace}`, namespace, name: namespace, kind: 'namespace-summary', recordCount, permitted: false })));
    } else if (operation === 'list_members') {
        const members = new Map<string, ApiRecord>();
        for (const record of records) {
            if (!record.className || !record.member && !record.name) continue;
            const key = `${record.namespace}:${record.className}:${record.member ?? record.name}`;
            const existing = members.get(key);
            if (existing) existing.recordCount = Number(existing.recordCount) + 1;
            else members.set(key, { id: `${version}:member-index:${key}`, namespace: record.namespace, className: record.className, member: record.member ?? record.name, name: record.member ?? record.name, kind: 'member-summary', recordCount: 1, permitted: false });
        }
        records.splice(0, records.length, ...[...members.values()].sort((a, b) => a.id.localeCompare(b.id)));
    }
    if (operation === 'get_signature') {
        const record = records[0] as ApiRecord | undefined;
        if (!record) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record signature is absent from the selected catalog scope/version/filters.' });
        records.splice(0, records.length, { id: record.id, namespace: record.namespace, className: record.className, member: record.member, name: record.name, kind: record.kind, signatures: record.signatures ?? [], permitted: false, evidenceStatus: 'declared' });
    }
    if (offset > records.length) throw new ToolError({ code: 'STALE_CURSOR', status: 409, message: 'Catalog cursor offset exceeds this result set.' });
    if (args.className && records.length === 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Class ${args.className} is absent from the ${version} catalog.` });
    if (args.recordId !== undefined && records.length === 0) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Record is absent from the selected catalog scope/version/filters.' });
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
    const result = (): Record<string, unknown> => ({ version, operation, coverage, catalogHash: index.catalogHash, records: selected, total: records.length, count: selected.length, truncated: offset + selected.length < records.length, nextCursor: cursorAt(offset + selected.length), live, runtimeVerified: false, qualified: false });
    if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'Required catalog metadata exceeds maxBytes.' });
    for (const record of records.slice(offset, offset + maxEntries)) {
        selected.push(external && ['records', 'get_signature'].includes(operation) ? ApiRecordSchema.parse({ ...external.readRecord(record.id), permitted: false, writablePath: null, evidenceStatus: 'declared' }) : record);
        if (Buffer.byteLength(JSON.stringify(result())) > maxBytes) { selected.pop(); break; }
    }
    if (offset < records.length && selected.length === 0) throw new ToolError({ code: 'RESULT_TOO_LARGE', status: 422, message: 'One catalog record cannot fit maxBytes; narrow the query or increase its explicit bound.' });
    return result();
}
