import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from './schema-validator';
import { ToolError } from './utcp/tool-error';
import type { infer as InferSchema } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const EntrySchema = z.object({ id: z.string().min(1), shard: z.number().int().nonnegative(), namespace: z.string(), className: z.string().nullable(), name: z.string(), member: z.string().nullable(), kind: z.string(), module: z.string().min(1).optional(), domain: z.string() });
const LookupSchema = z.object({ schemaVersion: z.literal(1), version: z.string(), catalogHash: digest, sourceIndexSha256: digest, shards: z.array(z.object({ file: z.string(), sha256: digest, count: z.number().int().nonnegative(), domain: z.string() })).max(1000), entries: z.array(EntrySchema).max(100000) });
const ConfigSchema = z.object({ schemaVersion: z.literal(1), catalogs: z.array(z.object({ version: z.enum(['3.7.3', '3.8.8']), catalogRoot: z.string().min(1), lookupRoot: z.string().min(1), lookupSha256: digest, catalogHash: digest })).max(2) });
type Lookup = InferSchema<typeof LookupSchema>;
export type ExternalApiEntry = InferSchema<typeof EntrySchema>;
const cache = new Map<string, { bytes: number; records: Map<string, Record<string, unknown>> }>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;

function readBounded(root: string, basename: string, maximum: number, expected?: string): Buffer {
    if (path.basename(basename) !== basename || basename === '.' || basename === '..') throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Unsafe catalog path.' });
    const file = fs.realpathSync(path.join(root, basename));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog file escapes its approved root.' });
    const before = fs.statSync(file);
    if (!before.isFile() || before.size > maximum) throw new ToolError({ code: 'CATALOG_LIMIT_EXCEEDED', status: 422, message: 'Catalog file exceeds its read bound.' });
    const data = fs.readFileSync(file);
    const after = fs.statSync(file);
    if (data.length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new ToolError({ code: 'CATALOG_CHANGED', status: 409, message: 'Catalog input changed while reading.' });
    if (expected && crypto.createHash('sha256').update(data).digest('hex') !== expected) throw new ToolError({ code: 'CATALOG_HASH_MISMATCH', status: 409, message: 'Catalog bytes do not match the approved identity.' });
    return data;
}

export interface ExternalApiCatalog {
    catalogHash: string;
    entries: ExternalApiEntry[];
    domains: Array<{ name: string; file: string; count: number }>;
    readRecord(id: string): Record<string, unknown>;
}

/** Operator-owned project config only. No request supplies filesystem paths or chooses a trust root. */
export function openExternalApiCatalog(version: string): ExternalApiCatalog | null {
    const projectPath: unknown = typeof Editor !== 'undefined' ? Editor.Project?.path : undefined;
    if (typeof projectPath !== 'string' || !projectPath) return null;
    const project = fs.realpathSync(projectPath);
    const configPath = path.join(project, '.ccp', 'engine-api-catalogs.json');
    if (!fs.existsSync(configPath)) return null;
    const configReal = fs.realpathSync(configPath);
    const configRelative = path.relative(project, configReal);
    if (configRelative.startsWith(`..${path.sep}`) || path.isAbsolute(configRelative)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog configuration escapes the project.' });
    const config = ConfigSchema.parse(JSON.parse(readBounded(path.dirname(configReal), path.basename(configReal), 16384).toString('utf8')));
    if (new Set(config.catalogs.map(item => item.version)).size !== config.catalogs.length) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Duplicate catalog version configuration.' });
    const selected = config.catalogs.find(item => item.version === version);
    if (!selected) return null;
    if (!path.isAbsolute(selected.catalogRoot) || !path.isAbsolute(selected.lookupRoot)) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Configured catalog roots must be absolute operator-owned paths.' });
    const root = fs.realpathSync(selected.catalogRoot), lookupRoot = fs.realpathSync(selected.lookupRoot);
    const lookup = LookupSchema.parse(JSON.parse(readBounded(lookupRoot, 'lookup.json', 32 * 1024 * 1024, selected.lookupSha256).toString('utf8')));
    if (lookup.version !== version || lookup.catalogHash !== selected.catalogHash) throw new ToolError({ code: 'CATALOG_HASH_MISMATCH', status: 409, message: 'Lookup version/catalog identity differs from configuration.' });
    readBounded(root, 'index.json', 1024 * 1024, lookup.sourceIndexSha256);
    const entriesById = new Map<string, ExternalApiEntry>();
    for (const entry of lookup.entries) {
        if (entriesById.has(entry.id) || !lookup.shards[entry.shard] || entry.domain !== lookup.shards[entry.shard].domain) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Catalog lookup identities are inconsistent.' });
        entriesById.set(entry.id, entry);
    }
    return {
        catalogHash: lookup.catalogHash, entries: lookup.entries,
        domains: lookup.shards.map(shard => ({ name: shard.domain, file: shard.file, count: shard.count })),
        readRecord(id) {
            const entry = entriesById.get(id);
            if (!entry) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Catalog record was not indexed.' });
            const shard = lookup.shards[entry.shard];
            const bytes = readBounded(root, shard.file, 8 * 1024 * 1024, shard.sha256);
            const key = `${root}:${lookup.catalogHash}:${shard.file}:${shard.sha256}`;
            let cached = cache.get(key);
            if (!cached) {
                const parsed = z.object({ records: z.array(z.record(z.string(), z.unknown())).max(10000) }).parse(JSON.parse(bytes.toString('utf8')));
                if (parsed.records.length !== shard.count) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record count differs from lookup.' });
                const records = new Map<string, Record<string, unknown>>();
                for (const record of parsed.records) {
                    if (typeof record.id !== 'string' || records.has(record.id) || record.version !== version) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Shard record identity/version is invalid.' });
                    records.set(record.id, record);
                }
                cached = { bytes: bytes.length, records };
                while (cache.size >= 8 || cacheBytes + cached.bytes > MAX_CACHE_BYTES) {
                    const oldest = cache.keys().next().value;
                    if (!oldest) break;
                    cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
                }
                cache.set(key, cached); cacheBytes += cached.bytes;
            } else { cache.delete(key); cache.set(key, cached); }
            const record = cached.records.get(id);
            if (!record || record.namespace !== entry.namespace || record.className !== entry.className || record.kind !== entry.kind || record.domain !== entry.domain.split('.').slice(1).join('.')) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed record does not match its actual shard metadata.' });
            if (entry.module !== undefined && record.module !== entry.module) throw new ToolError({ code: 'CATALOG_INVALID', status: 422, message: 'Indexed module differs from verified record metadata.' });
            return { ...record };
        },
    };
}
