import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import fs from 'fs-extra';
import path from 'path';
import { VERBOSE_PREFAB_BYTES } from '../utils/verbose';
import { ToolError } from '../tool-error';
import { invalidateAfterWrite } from '../utils/memo-cache';

function normalizePrefabPath(p?: string): string {
    if (!p) return '';
    let s = p.replace(/\\/g, '/').trim();
    if (s.startsWith('db://')) return s.endsWith('/') ? s.slice(0, -1) : s;
    if (s.startsWith('/')) s = s.slice(1);
    if (s === '' || s === 'assets') return 'db://assets';
    if (s.startsWith('assets/')) { const r = 'db://' + s; return r.endsWith('/') ? r.slice(0, -1) : r; }
    return `db://assets/${s.replace(/^\/+/, '')}`;
}

async function resolvePrefab(ident: string): Promise<{ url: string, uuid: string, file: string }> {
    const isDbUrl = ident.startsWith('db://');
    const url = isDbUrl ? ident : undefined;
    const uuid = isDbUrl ? undefined : ident;
    let info: any = null;

    if (uuid) info = await Editor.Message.request('asset-db', 'query-asset-info', uuid).catch(() => null);
    else if (url) info = await Editor.Message.request('asset-db', 'query-asset-info', url).catch(() => null);
    if (!info) {
        throw new ToolError({
            code: 'TARGET_NOT_FOUND',
            status: 404,
            message: `Prefab not found: ${ident}`,
            details: { asset: ident },
            recovery: 'Use assetGetTree or assetResolvePath to inspect available prefab assets.',
        });
    }
    const resolvedUrl: string | undefined = info?.url || url;
    const resolvedUuid: string | undefined = info?.uuid || uuid;
    if (!resolvedUrl || !resolvedUuid) throw new Error(`Prefab not found: ${ident}`);

    // Prefab type guard — allow only .prefab assets
    if (info && info.type !== 'cc.Prefab' && info.ext !== '.prefab' && !resolvedUrl.endsWith('.prefab')) {
        // Still allow — Cocos sometimes reports type differently, but warn via error if clearly wrong
        if (info.type && info.type !== 'cc.Prefab') {
            throw new ToolError({
                code: 'ASSET_TYPE_MISMATCH',
                message: `readPrefabJson accepts cc.Prefab; received ${info.type}.`,
                details: {
                    assetPath: resolvedUrl,
                    expectedTypes: ['cc.Prefab'],
                    actualType: info.type,
                },
                recovery: 'Use sceneSnapshot, nodeGetTree, or inspectorGet for a scene.',
            });
        }
    }

    let file: string | null = info?.file || null;
    if (!file) file = await Editor.Message.request('asset-db', 'query-path', resolvedUuid || resolvedUrl).catch(() => null);
    if (!file) throw new Error(`Cannot resolve filesystem path for prefab ${resolvedUrl}`);
    return { url: resolvedUrl, uuid: resolvedUuid!, file: file as string };
}

function collectPrefabSummary(value: unknown): { rootNode: unknown, totalEntries: number, components: string[], references: string[] } {
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@[A-Za-z0-9_-]+)?/gi;
    const components = new Set<string>();
    const references = new Set<string>();
    let totalEntries = 0;
    let rootNode: unknown = null;
    const visit = (candidate: unknown, isRoot = false): void => {
        if (candidate === null || typeof candidate !== 'object') {
            if (typeof candidate === 'string') for (const match of candidate.match(uuidPattern) ?? []) references.add(match.split('@', 1)[0].toLowerCase());
            return;
        }
        totalEntries += 1;
        if (isRoot) rootNode = candidate;
        for (const [key, child] of Object.entries(candidate)) {
            if (key === '__type__' || key === '_type' || key === 'type') {
                let type: unknown = child;
                if (child && typeof child === 'object' && 'value' in child) type = child.value;
                if (typeof type === 'string' && type) components.add(type);
            }
            visit(child);
        }
    };
    visit(value, true);
    return { rootNode, totalEntries, components: [...components].sort(), references: [...references].sort() };
}

export class PrefabJsonTools {

    @utcpTool(
        'prefabInspect',
        'Inspect a bounded serialized .prefab asset and return its root record, entry count, component types, and UUID references.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, assetPath: { type: 'string' } },
            anyOf: [{ required: ['reference'] }, { required: ['assetPath'] }],
        },
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, url: { type: 'string' }, uuid: { type: 'string' }, rootNode: {}, totalEntries: { type: 'integer' }, components: { type: 'array' }, references: { type: 'array' } },
            required: ['reference', 'url', 'uuid', 'rootNode', 'totalEntries', 'components', 'references'],
        },
        'GET', ['prefab', 'inspect', 'json', 'asset']
    )
    async prefabInspect(args: { reference?: IInstanceReference, assetPath?: string }): Promise<Record<string, unknown>> {
        const loaded = await this.readPrefabJson(args);
        const parsed = JSON.parse(loaded.content) as unknown;
        return { reference: { id: loaded.uuid, type: 'cc.Prefab' }, url: loaded.url, uuid: loaded.uuid, ...collectPrefabSummary(parsed) };
    }
    @utcpTool(
        'prefabInfo',
        'Get bounded authoritative information for a serialized .prefab asset, including its root record, entry count, component types, UUID references, and asset identity.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, assetPath: { type: 'string' } },
            anyOf: [{ required: ['reference'] }, { required: ['assetPath'] }],
        },
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, url: { type: 'string' }, uuid: { type: 'string' }, rootNode: {}, totalEntries: { type: 'integer' }, components: { type: 'array' }, references: { type: 'array' } },
            required: ['reference', 'url', 'uuid', 'rootNode', 'totalEntries', 'components', 'references'],
        },
        'GET', ['prefab', 'info', 'inspect', 'asset']
    )
    async prefabInfo(args: { reference?: IInstanceReference, assetPath?: string }): Promise<Record<string, unknown>> {
        const loaded = await this.readPrefabJson(args);
        const parsed = JSON.parse(loaded.content) as unknown;
        return { reference: { id: loaded.uuid, type: 'cc.Prefab' }, url: loaded.url, uuid: loaded.uuid, ...collectPrefabSummary(parsed) };
    }

    @utcpTool(
        'prefabValidate',
        'Validate a bounded serialized .prefab asset: JSON structure, asset type, UUID references, and imported dependency availability.',
        {
            type: 'object',
            properties: { reference: InstanceReferenceSchema, assetPath: { type: 'string' }, maxReferences: { type: 'integer', minimum: 1, maximum: 2000, default: 2000 } },
            anyOf: [{ required: ['reference'] }, { required: ['assetPath'] }],
        },
        {
            type: 'object',
            properties: { valid: { type: 'boolean' }, reference: InstanceReferenceSchema, url: { type: 'string' }, uuid: { type: 'string' }, references: { type: 'array' }, missingReferences: { type: 'array' }, issues: { type: 'array' }, totalEntries: { type: 'integer' }, totalReferences: { type: 'integer' }, truncated: { type: 'boolean' }, complete: { type: 'boolean' } },
            required: ['valid', 'reference', 'url', 'uuid', 'references', 'missingReferences', 'issues', 'totalEntries', 'totalReferences', 'truncated', 'complete'],
        },
        'GET', ['prefab', 'validate', 'asset']
    )
    async prefabValidate(args: { reference?: IInstanceReference, assetPath?: string, maxReferences?: number }): Promise<Record<string, unknown>> {
        const loaded = await this.readPrefabJson(args);
        const parsed = JSON.parse(loaded.content) as unknown;
        const summary = collectPrefabSummary(parsed);
        const maxReferences = args.maxReferences === undefined ? 2000 : args.maxReferences;
        if (!Number.isInteger(maxReferences) || maxReferences < 1 || maxReferences > 2000) throw new Error('maxReferences must be an integer from 1 to 2000.');
        const references = summary.references.slice(0, maxReferences);
        const rows = await Editor.Message.request('asset-db', 'query-assets', { pattern: 'db://assets/**' });
        if (!Array.isArray(rows)) throw new ToolError({ code: 'ASSET_DATABASE_UNAVAILABLE', status: 502, message: 'Prefab validation requires an authoritative asset database inventory.' });
        const known = new Set<string>();
        if (Array.isArray(rows)) {
            for (const row of rows) {
                if (!row || typeof row !== 'object' || !('uuid' in row)) continue;
                const uuid = row.uuid;
                if (typeof uuid === 'string') known.add(uuid.split('@', 1)[0].toLowerCase());
            }
        }
        const missingReferences = references.filter((id) => !known.has(id.split('@', 1)[0].toLowerCase())).map((id) => ({ id }));
        const issues = missingReferences.map((entry) => ({ code: 'MISSING_REFERENCE', id: entry.id }));
        const truncated = references.length < summary.references.length;
        if (truncated) issues.push({ code: 'REFERENCE_LIMIT_REACHED', id: loaded.uuid });
        return { valid: missingReferences.length === 0 && !truncated, complete: !truncated, truncated, totalReferences: summary.references.length, reference: { id: loaded.uuid, type: 'cc.Prefab' }, url: loaded.url, uuid: loaded.uuid, references, missingReferences, issues, totalEntries: summary.totalEntries };
    }

    @utcpTool(
        'readPrefabJson',
        'Read the raw JSON content of a .prefab asset (via uuid or db:// path). Returns the parsed JSON string and metadata. Default 4MB; verbose=true lifts to 10MB.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                assetPath: { type: 'string', description: 'db:// path to the .prefab, alternative to reference.id' },
                verbose: { type: 'boolean', description: 'When true, lifts size cap to 10MB.' },
            },
            anyOf: [
                { required: ['reference'] },
                { required: ['assetPath'] },
            ],
        },
        {
            type: 'object',
            properties: {
                content: { type: 'string', description: 'Raw JSON text of the prefab file' },
                url: { type: 'string' },
                uuid: { type: 'string' },
                filesystemPath: { type: 'string' },
            },
            required: ['content', 'url', 'uuid'],
        },
        'GET',
        ['prefab', 'json', 'read', 'asset', 'file', 'inspect']
    )
    async readPrefabJson(args: { reference?: IInstanceReference, assetPath?: string, verbose?: boolean }): Promise<{ content: string, url: string, uuid: string, filesystemPath: string }> {
        const ident = args.reference?.id || (args.assetPath ? normalizePrefabPath(args.assetPath) : undefined);
        if (!ident) throw new Error('readPrefabJson requires reference.id or assetPath');
        const { url, uuid, file } = await resolvePrefab(ident);
        const stat = await (fs as any).stat(file).catch(() => null);
        if (!stat) throw new Error(`Prefab file not found on disk: ${file}`);
        const cap = args.verbose ? VERBOSE_PREFAB_BYTES : 4 * 1024 * 1024;
        if (stat.size > cap) throw new Error(`Prefab file too large (${stat.size} bytes, cap ${cap}). ${args.verbose ? 'Already at verbose cap (10MB).' : 'Pass verbose=true to lift to 10MB.'}`);
        const content = await (fs as any).readFile(file, 'utf8');
        // Validate JSON
        try { JSON.parse(content); } catch (e: any) { throw new Error(`Prefab JSON parse error: ${e.message}`); }
        return { content, url, uuid, filesystemPath: file };
    }

    @utcpTool(
        'editPrefabJson',
        'Overwrite the raw JSON content of a .prefab asset. Validates JSON before writing and refreshes asset-db afterwards.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                assetPath: { type: 'string', description: 'db:// path to the .prefab' },
                content: { type: 'string', description: 'New JSON text for the prefab file (must be valid JSON)' },
            },
            required: ['content'],
            anyOf: [
                { required: ['reference'] },
                { required: ['assetPath'] },
            ],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                url: { type: 'string' },
                uuid: { type: 'string' },
            },
            required: ['success'],
        },
        'POST',
        ['prefab', 'json', 'edit', 'write', 'asset', 'save']
    )
    async editPrefabJson(args: { reference?: IInstanceReference, assetPath?: string, content: string }): Promise<{ success: boolean, url: string, uuid: string }> {
        const ident = args.reference?.id || (args.assetPath ? normalizePrefabPath(args.assetPath) : undefined);
        if (!ident) throw new Error('editPrefabJson requires reference.id or assetPath');
        if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('editPrefabJson requires non-empty content string');
        try { JSON.parse(args.content); } catch (e: any) { throw new Error(`Invalid JSON: ${e.message}`); }
        const { url, uuid, file } = await resolvePrefab(ident);
        await (fs as any).writeFile(file, args.content, 'utf8');
        try { await Editor.Message.request('asset-db', 'refresh-asset', url); } catch { /* best-effort hint: the write itself was verified; asset-db re-import is owned by the editor */ }
        invalidateAfterWrite();
        return { success: true, url, uuid };
    }

    @utcpTool(
        'duplicatePrefab',
        'Duplicate a prefab asset to a new db:// path (copy-asset). Fails if target already exists unless overwrite is true.',
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                assetPath: { type: 'string', description: 'db:// path of the source prefab' },
                targetAssetPath: { type: 'string', description: 'db:// path for the duplicated prefab' },
                overwrite: { type: 'boolean', description: 'Overwrite if target exists (default false)' },
            },
            required: ['targetAssetPath'],
            anyOf: [
                { required: ['reference'] },
                { required: ['assetPath'] },
            ],
        },
        {
            type: 'object',
            properties: {
                reference: InstanceReferenceSchema,
                url: { type: 'string' },
            },
            required: ['reference'],
        },
        'POST',
        ['prefab', 'duplicate', 'copy', 'clone', 'asset']
    )
    async duplicatePrefab(args: { reference?: IInstanceReference, assetPath?: string, targetAssetPath: string, overwrite?: boolean }): Promise<{ reference: IInstanceReference, url: string }> {
        const ident = args.reference?.id || (args.assetPath ? normalizePrefabPath(args.assetPath) : undefined);
        if (!ident) throw new Error('duplicatePrefab requires reference.id or assetPath (source)');
        if (!args.targetAssetPath) throw new Error('duplicatePrefab requires targetAssetPath');
        const { url: sourceUrl } = await resolvePrefab(ident);
        const targetPath = normalizePrefabPath(args.targetAssetPath);
        if (!targetPath.endsWith('.prefab')) throw new Error('targetAssetPath must end with .prefab');

        const assetOptions: any = { overwrite: !!args.overwrite, rename: false };
        const result: any = await Editor.Message.request('asset-db', 'copy-asset', sourceUrl, targetPath, assetOptions);
        if (!result) throw new Error(`Failed to duplicate prefab ${sourceUrl} → ${targetPath}`);
        return { reference: { id: result.uuid, type: result.type || 'cc.Prefab' }, url: result.url || targetPath };
    }
}
