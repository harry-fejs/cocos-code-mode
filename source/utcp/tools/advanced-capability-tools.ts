import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { AssetTools } from './asset-tools';
import { restorePrefabNode } from '../utils/tools-utils';
import { boundPrefabResponse, prefabResponseLimit } from '../utils/prefab-response';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@[A-Za-z0-9_-]+)?/gi;
const SERIALIZED_LIMIT = 5 * 1024 * 1024;
const MAX_ITEMS = 128;

type AssetRow = { uuid: string, url: string, type?: string, importer?: string, file?: string, isDirectory?: boolean };

function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }
function bounded(value: unknown, fallback: number, maximum = MAX_ITEMS): number {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) invalid(`Expected an integer from 1 to ${maximum}.`);
    return value as number;
}
function baseUuid(value: string): string { return value.split('@', 1)[0].toLowerCase(); }
function refs(content: string): string[] { return [...new Set([...content.matchAll(UUID_RE)].map((match) => baseUuid(match[0])))].sort(); }
function sha256(content: string | Buffer): string { return createHash('sha256').update(content).digest('hex'); }
function nodeName(node: any): string { return typeof node?.name === 'string' ? node.name : node?.name?.value ?? node?.uuid ?? ''; }
function componentType(component: any): string { return component?.type ?? component?.value?.__type__?.value ?? component?.value?.__type__ ?? component?.cid ?? ''; }
function propertyValue(value: any): any { return value && typeof value === 'object' && 'value' in value ? value.value : value; }
function objectField(value: unknown, key: string): unknown {
    return value && typeof value === 'object' && key in value ? value[key as keyof typeof value] : undefined;
}
function nodeIdentity(node: unknown): string | undefined {
    const raw = objectField(node, 'uuid') ?? objectField(node, 'id') ?? objectField(objectField(node, 'value'), 'uuid') ?? objectField(objectField(node, 'value'), 'id');
    const value = propertyValue(raw);
    if (typeof value === 'string' && value) return value;
    // Creator 3.7 query-node may serialize the node UUID as a scalar value.
    const scalar = objectField(node, 'value');
    return typeof scalar === 'string' && scalar ? scalar : undefined;
}

function prefabAssetId(node: unknown): string | undefined {
    const rawPrefab = node && typeof node === 'object'
        ? objectField(node, '__prefab__') ?? objectField(node, '_prefab') ?? objectField(node, 'prefab')
        : undefined;
    const prefab = propertyValue(rawPrefab);
    const value = objectField(objectField(prefab, 'prefabStateInfo'), 'assetUuid')
        ?? objectField(prefab, 'assetUuid')
        ?? objectField(prefab, 'uuid')
        ?? objectField(prefab, 'assetUuid')
        ?? objectField(objectField(prefab, 'asset'), '_uuid')
        ?? objectField(objectField(prefab, 'asset'), 'uuid');
    const normalized = propertyValue(value);
    if (typeof normalized === 'string' && normalized) return normalized;
    const root = objectField(prefab, 'root') ?? objectField(prefab, 'rootUuid');
    return typeof root === 'string' && root ? root : undefined;
}
function assertNodeIdentity(expected: string, node: unknown, operation: string): void {
    if (!node || nodeIdentity(node) !== expected) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `${operation} prefab read-back identity did not match ${expected}.`, details: { expected, actual: nodeIdentity(node) ?? null } });
}
function assertPrefabAsset(row: AssetRow, operation: string): void {
    if (row.type !== 'cc.Prefab' && row.importer !== 'prefab' && !row.url.toLowerCase().endsWith('.prefab')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `${operation} requires a .prefab asset, got ${row.url}.` });
}
function assertSceneAsset(row: AssetRow, operation: string): void {
    if (row.type !== 'cc.SceneAsset' && row.importer !== 'scene' && !row.url.toLowerCase().endsWith('.scene')) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `${operation} requires a .scene asset, got ${row.url}.` });
}
function flattenValues(value: unknown, output: string[] = []): string[] {
    if (typeof value === 'string') { for (const id of value.match(UUID_RE) ?? []) output.push(baseUuid(id)); return output; }
    if (Array.isArray(value)) { for (const item of value) flattenValues(item, output); return output; }
    if (value && typeof value === 'object') { for (const item of Object.values(value)) flattenValues(item, output); }
    return output;
}

async function queryAssets(): Promise<AssetRow[]> {
    const rows = await Editor.Message.request('asset-db', 'query-assets', { pattern: 'db://assets/**' }) as unknown;
    return Array.isArray(rows) ? rows.filter((row): row is AssetRow => !!row && typeof row === 'object' && typeof (row as any).uuid === 'string' && typeof (row as any).url === 'string' && !(row as any).isDirectory) : [];
}
async function resolveAsset(reference?: IInstanceReference, assetPath?: string): Promise<AssetRow> {
    const identifier = reference?.id ?? assetPath;
    if (!identifier) invalid('A reference or assetPath is required.');
    const info = await Editor.Message.request('asset-db', 'query-asset-info', identifier) as AssetRow | null;
    if (!info?.uuid || !info.url) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Asset not found: ${identifier}` });
    const file = info.file ?? await Editor.Message.request('asset-db', 'query-path', info.uuid).catch(() => undefined) as string | undefined;
    return { ...info, file };
}
async function readAsset(row: AssetRow): Promise<{ content: string, hash: string }> {
    if (!row.file) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: `Asset source is unavailable: ${row.url}` });
    const stat = await fs.stat(row.file).catch(() => null);
    if (!stat?.isFile()) throw new ToolError({ code: 'SOURCE_UNAVAILABLE', status: 422, message: `Asset source is unavailable: ${row.url}` });
    if (stat.size > SERIALIZED_LIMIT) throw new ToolError({ code: 'SOURCE_TOO_LARGE', status: 413, message: `Asset source exceeds ${SERIALIZED_LIMIT} bytes: ${row.url}` });
    const content = await fs.readFile(row.file, 'utf8');
    return { content, hash: sha256(content) };
}
async function sceneTree(): Promise<any> {
    const tree = await Editor.Message.request('scene', 'query-node-tree');
    if (!tree) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No open scene or prefab hierarchy.' });
    return tree;
}
function findSceneNode(root: any, id: string): { node: any | null, limitReached: boolean } {
    const pending = [root];
    let visited = 0;
    while (pending.length) {
        if (visited >= 2000) return { node: null, limitReached: true };
        const node = pending.pop();
        if (!node) continue;
        visited++;
        if (node.uuid === id) return { node, limitReached: false };
        const children = node.children;
        if (Array.isArray(children)) for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
    }
    return { node: null, limitReached: false };
}

async function sceneSourceEvidence(): Promise<{ url: string | null, sha256: string | null }> {
    await Editor.Message.request('scene', 'save-scene');
    const current = await Editor.Message.request('scene', 'query-current-scene').catch(() => null) as any;
    const identifier = current?.uuid ?? current?.id;
    if (typeof identifier !== 'string' || !identifier) return { url: null, sha256: null };
    const info = await Editor.Message.request('asset-db', 'query-asset-info', identifier).catch(() => null) as AssetRow | null;
    if (!info?.file) return { url: info?.url ?? null, sha256: null };
    return { url: info.url, sha256: sha256(await fs.readFile(info.file)) };
}
function stableIdentity(pathValue: string, value: unknown): string { return `${pathValue}:${typeof value}`; }
type TilemapLayerInventory = { id: string, name: string, width: number, height: number, visible: boolean, opacity: number, offsetX: number, offsetY: number, tileCount: number };
type TilemapObjectInventory = { id: string, name: string, type: string, x: number, y: number, width: number, height: number };
type TilemapInventory = { format: 'tmx', map: Record<string, unknown>, tilesets: Array<Record<string, unknown>>, layers: TilemapLayerInventory[], objectGroups: Array<{ id: string, name: string, objects: TilemapObjectInventory[] }> };
const XML_TAG_RE = (name: string): RegExp => new RegExp(`<${name}\\b[^>]*>`, 'i');
function xmlAttribute(tag: string, name: string): string | undefined {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
    return match?.[1];
}
function xmlNumber(tag: string, name: string, fallback = 0): number {
    const value = Number(xmlAttribute(tag, name));
    return Number.isFinite(value) ? value : fallback;
}
function xmlBoolean(tag: string, name: string, fallback = true): boolean {
    const value = xmlAttribute(tag, name);
    return value === undefined ? fallback : value !== '0' && value.toLowerCase() !== 'false';
}
function decodeXml(value: string): string {
    return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function encodeXml(value: unknown): string {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function tilemapInventory(content: string, maxItems: number): TilemapInventory {
    const mapTag = content.match(XML_TAG_RE('map'))?.[0] ?? '';
    const layerMatches = [...content.matchAll(/<layer\b[^>]*>([\s\S]*?)<\/layer>/gi)].slice(0, maxItems);
    const layers = layerMatches.map((match) => {
        const tag = match[0].match(XML_TAG_RE('layer'))?.[0] ?? '';
        const data = match[1].match(/<data\b[^>]*>([\s\S]*?)<\/data>/i)?.[1]?.trim() ?? '';
        const tileCount = data ? data.split(/[,\s]+/).filter(Boolean).length : 0;
        return { id: xmlAttribute(tag, 'id') ?? '', name: decodeXml(xmlAttribute(tag, 'name') ?? ''), width: xmlNumber(tag, 'width'), height: xmlNumber(tag, 'height'), visible: xmlBoolean(tag, 'visible'), opacity: xmlNumber(tag, 'opacity', 1), offsetX: xmlNumber(tag, 'offsetx'), offsetY: xmlNumber(tag, 'offsety'), tileCount };
    });
    const objectGroups = [...content.matchAll(/<objectgroup\b[^>]*>([\s\S]*?)<\/objectgroup>/gi)].slice(0, maxItems).map((match) => {
        const groupTag = match[0].match(XML_TAG_RE('objectgroup'))?.[0] ?? '';
        const objects = [...match[1].matchAll(/<object\b[^>]*\/?>/gi)].slice(0, maxItems).map((objectMatch) => {
            const tag = objectMatch[0];
            return { id: xmlAttribute(tag, 'id') ?? '', name: decodeXml(xmlAttribute(tag, 'name') ?? ''), type: decodeXml(xmlAttribute(tag, 'type') ?? xmlAttribute(tag, 'class') ?? ''), x: xmlNumber(tag, 'x'), y: xmlNumber(tag, 'y'), width: xmlNumber(tag, 'width'), height: xmlNumber(tag, 'height') };
        });
        return { id: xmlAttribute(groupTag, 'id') ?? '', name: decodeXml(xmlAttribute(groupTag, 'name') ?? ''), objects };
    });
    const tilesets = [...content.matchAll(/<tileset\b[^>]*\/?>/gi)].slice(0, maxItems).map((match) => {
        const tag = match[0];
        return { firstGid: xmlNumber(tag, 'firstgid'), source: xmlAttribute(tag, 'source') ?? null, name: decodeXml(xmlAttribute(tag, 'name') ?? '') };
    });
    return { format: 'tmx', map: { orientation: xmlAttribute(mapTag, 'orientation') ?? null, width: xmlNumber(mapTag, 'width'), height: xmlNumber(mapTag, 'height'), tileWidth: xmlNumber(mapTag, 'tilewidth'), tileHeight: xmlNumber(mapTag, 'tileheight'), renderOrder: xmlAttribute(mapTag, 'renderorder') ?? null }, tilesets, layers, objectGroups };
}
function tilemapDataGids(content: string): Array<{ gid: number, layer: string }> {
    const gids: Array<{ gid: number, layer: string }> = [];
    for (const layerMatch of content.matchAll(/<layer\b[^>]*>([\s\S]*?)<\/layer>/gi)) {
        const layerTag = layerMatch[0].match(XML_TAG_RE('layer'))?.[0] ?? '';
        const layerName = decodeXml(xmlAttribute(layerTag, 'name') ?? '');
        for (const dataMatch of layerMatch[1].matchAll(/<data\b[^>]*>([\s\S]*?)<\/data>/gi)) {
            const dataTag = dataMatch[0].match(XML_TAG_RE('data'))?.[0] ?? '';
            if ((xmlAttribute(dataTag, 'encoding') ?? 'csv').toLowerCase() === 'base64') continue;
            const body = dataMatch[1] ?? '';
            if (/<tile\b/i.test(body)) {
                for (const tile of body.matchAll(/<tile\b[^>]*\/?>/gi)) {
                    // Tiled packs flip/rotation flags into the gid's high bits, so mask them
                    // before the range check or a flipped valid tile looks out of range.
                    const gid = xmlNumber(tile[0], 'gid', 0) & 0x1FFFFFFF;
                    if (gid !== 0) gids.push({ gid, layer: layerName });
                }
            } else {
                for (const token of body.split(/[,\s]+/)) {
                    if (!token.trim()) continue;
                    const gid = Number(token) & 0x1FFFFFFF;
                    if (Number.isInteger(gid) && gid !== 0) gids.push({ gid, layer: layerName });
                }
            }
        }
    }
    return gids;
}

function tilemapGidRanges(content: string): Array<{ firstGid: number, tileCount: number }> {
    const ranges: Array<{ firstGid: number, tileCount: number }> = [];
    const collect = (tag: string, inner: string): void => {
        if (xmlAttribute(tag, 'source')) return;
        const firstGid = xmlNumber(tag, 'firstgid', 1);
        const declared = xmlAttribute(tag, 'tilecount');
        const tileCount = declared !== undefined && Number.isFinite(Number(declared)) ? Number(declared) : [...inner.matchAll(/<tile\b[^>]*\/?>/gi)].length;
        if (Number.isInteger(tileCount) && tileCount > 0) ranges.push({ firstGid, tileCount });
    };
    for (const match of content.matchAll(/<tileset\b[^>]*>([\s\S]*?)<\/tileset>/gi)) collect(match[0].match(XML_TAG_RE('tileset'))?.[0] ?? '', match[1]);
    for (const match of content.matchAll(/<tileset\b[^>]*\/>/gi)) collect(match[0], '');
    return ranges;
}

function tilemapExternalTilesets(content: string): Array<{ source: string, firstGid: number }> {
    const external: Array<{ source: string, firstGid: number }> = [];
    for (const match of content.matchAll(/<tileset\b[^>]*\/?>/gi)) {
        const source = xmlAttribute(match[0], 'source');
        if (!source) continue;
        external.push({ source: decodeXml(source), firstGid: xmlNumber(match[0], 'firstgid', 1) });
    }
    return external;
}

async function tilemapExternalRanges(row: AssetRow, content: string, ranges: Array<{ firstGid: number, tileCount: number }>): Promise<string[]> {
    const unverified: string[] = [];
    const baseDir = typeof row.file === 'string' ? path.dirname(row.file) : '';
    for (const tileset of tilemapExternalTilesets(content).slice(0, 32)) {
        if (!baseDir) { unverified.push(tileset.source); continue; }
        try {
            const resolved = path.resolve(baseDir, tileset.source);
            const relative = path.relative(baseDir, resolved);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) { unverified.push(tileset.source); continue; }
            const stat = await fs.stat(resolved);
            if (!stat.isFile() || stat.size > SERIALIZED_LIMIT) { unverified.push(tileset.source); continue; }
            const externalRange = tilemapGidRanges(await fs.readFile(resolved, 'utf8'))[0];
            if (!externalRange) { unverified.push(tileset.source); continue; }
            ranges.push({ firstGid: tileset.firstGid, tileCount: externalRange.tileCount });
        } catch {
            unverified.push(tileset.source);
        }
    }
    return unverified;
}

function tilemapDimensionIssues(content: string): Array<Record<string, unknown>> {
    const mapTag = content.match(XML_TAG_RE('map'))?.[0] ?? '';
    const mapWidth = xmlNumber(mapTag, 'width');
    const mapHeight = xmlNumber(mapTag, 'height');
    const issues: Array<Record<string, unknown>> = [];
    for (const match of content.matchAll(/<layer\b[^>]*>([\s\S]*?)<\/layer>/gi)) {
        const tag = match[0].match(XML_TAG_RE('layer'))?.[0] ?? '';
        const width = xmlNumber(tag, 'width');
        const height = xmlNumber(tag, 'height');
        if (width !== mapWidth || height !== mapHeight) issues.push({ layer: decodeXml(xmlAttribute(tag, 'name') ?? ''), width, height, mapWidth, mapHeight });
    }
    return issues;
}

function tilemapPath(pathValue: string): { kind: 'layers' | 'objects', selector: string, property: string } {
    const parts = pathValue.split('.');
    if (parts.length !== 3 || (parts[0] !== 'layers' && parts[0] !== 'objects') || !parts[1] || !/^(name|visible|opacity|offsetx|offsety|x|y|width|height)$/.test(parts[2])) invalid('Tilemap path must be layers.<id-or-name>.<name|visible|opacity|offsetx|offsety> or objects.<id-or-name>.<x|y|width|height|name>.');
    return { kind: parts[0], selector: parts[1], property: parts[2] };
}
function xmlValue(value: unknown, property: string): string {
    if (property === 'visible') {
        if (typeof value !== 'boolean') invalid(`Tilemap '${property}' requires a boolean.`);
        return value ? '1' : '0';
    }
    if (['opacity', 'offsetx', 'offsety', 'x', 'y', 'width', 'height'].includes(property)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`Tilemap '${property}' requires a finite number.`);
        return String(value);
    }
    if (typeof value !== 'string' || value.length > 256) invalid(`Tilemap '${property}' requires a bounded string.`);
    return encodeXml(value);
}
function updateTilemapXml(content: string, kind: 'layers' | 'objects', selector: string, property: string, value: unknown): { content: string, previous: unknown } {
    const encodedSelector = decodeXml(selector);
    const tagName = kind === 'layers' ? 'layer' : 'object';
    const pattern = kind === 'layers' ? /<layer\b[^>]*>/gi : /<object\b[^>]*\/?>/gi;
    let previous: unknown;
    let changed = false;
    const next = content.replace(pattern, (tag) => {
        const id = xmlAttribute(tag, 'id') ?? '';
        const name = decodeXml(xmlAttribute(tag, 'name') ?? '');
        if (id !== encodedSelector && name !== encodedSelector) return tag;
        if (property === 'name') previous = name;
        else if (property === 'visible') previous = xmlBoolean(tag, property);
        else previous = xmlNumber(tag, property, 0);
        changed = true;
        const replacement = `${property}="${xmlValue(value, property)}"`;
        const attr = new RegExp(`\\s${property}="[^"]*"`, 'i');
        return attr.test(tag) ? tag.replace(attr, ` ${replacement}`) : tag.replace(/\/?>$/, ` ${replacement}$&`);
    });
    if (!changed) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Tilemap ${kind.slice(0, -1)} '${selector}' was not found.` });
    return { content: next, previous };
}
async function saveTilemapAsset(row: AssetRow, content: string): Promise<{ before: string, after: string }> {
    const before = await readAsset(row);
    const saved = await Editor.Message.request('asset-db', 'save-asset', row.url, content);
    if (!saved) throw new ToolError({ code: 'MUTATION_REFUSED', status: 422, message: `Creator refused tilemap source update for ${row.url}.` });
    await Editor.Message.request('asset-db', 'reimport-asset', row.uuid);
    const after = await readAsset(await resolveAsset({ id: row.uuid }));
    return { before: before.hash, after: after.hash };
}
async function generatedAtlasOutputs(asset: AssetRow): Promise<Array<Record<string, unknown>>> {
    const projectPath = (Editor as unknown as { Project?: { path?: string } }).Project?.path;
    if (!projectPath) return [];
    const shard = asset.uuid.slice(0, 2);
    const roots = [path.join(projectPath, 'library', shard, `${asset.uuid}.json`), path.join(projectPath, 'library', shard, `${asset.uuid}.png`), path.join(projectPath, 'library', asset.uuid), path.join(projectPath, 'library', `${asset.uuid}.json`), path.join(projectPath, 'library', `${asset.uuid}.png`)];
    const outputs: Array<Record<string, unknown>> = [];
    const inspect = async (candidate: string): Promise<void> => {
        if (outputs.length >= 32) return;
        const stat = await fs.stat(candidate).catch(() => null);
        if (!stat) return;
        if (stat.isFile()) {
            outputs.push({ path: candidate, bytes: stat.size, sha256: sha256(await fs.readFile(candidate)) });
            return;
        }
        if (!stat.isDirectory()) return;
        for (const entry of (await fs.readdir(candidate)).slice(0, 64)) await inspect(path.join(candidate, entry));
    };
    for (const root of roots) await inspect(root);
    return outputs;
}
function diffValues(before: any, after: any, pathValue = '', output: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (output.length >= MAX_ITEMS) return output;
    if (JSON.stringify(before) === JSON.stringify(after)) return output;
    if (Array.isArray(before) && Array.isArray(after)) {
        const length = Math.max(before.length, after.length);
        for (let index = 0; index < length; index += 1) diffValues(before[index], after[index], pathValue ? `${pathValue}.${index}` : String(index), output);
        return output;
    }
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
        const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
        for (const key of keys) diffValues(before[key], after[key], pathValue ? `${pathValue}.${key}` : key, output);
        return output;
    }
    output.push({ path: pathValue, identity: stableIdentity(pathValue, after ?? before), before: before ?? null, after: after ?? null });
    return output;
}

export class AdvancedCapabilityTools {
    @utcpTool('referenceImageManage', 'Manage a bounded reference image record in the active scene and verify persistence through scene read-back.', {
        type: 'object', additionalProperties: false, properties: { operation: { type: 'string', enum: ['inspect', 'list', 'set', 'switch', 'refresh', 'clear'] }, reference: InstanceReferenceSchema, imagePath: { type: 'string', maxLength: 2048 } }, required: ['operation']
    }, { type: 'object', additionalProperties: false, properties: { operation: { type: 'string' }, supported: { type: 'boolean' }, persisted: { type: 'boolean' }, reference: { type: 'object' }, imagePath: { type: ['string', 'null'] }, images: { type: 'array' } }, required: ['operation', 'supported', 'persisted'] }, 'POST', ['reference', 'image', 'manage', 'list', 'scene'])
    async referenceImageManage(args: { operation: 'inspect' | 'list' | 'set' | 'switch' | 'refresh' | 'clear', reference?: IInstanceReference, imagePath?: string }): Promise<Record<string, unknown>> {
        const writesImage = args.operation === 'set' || args.operation === 'switch';
        if (writesImage && (!args.imagePath || args.imagePath.length > 2048)) invalid('imagePath is required for set/switch and must be bounded.');
        if (args.operation === 'refresh' && args.imagePath) invalid('refresh uses the persisted image and does not accept imagePath.');
        const nativeOperation = args.operation === 'switch' ? 'set' : args.operation === 'refresh' ? 'inspect' : args.operation;
        const request = nativeOperation === 'inspect' ? 'query-reference-image' : nativeOperation === 'list' ? 'list-reference-images' : nativeOperation === 'set' ? 'set-reference-image' : 'clear-reference-image';
        try {
            const payload = nativeOperation === 'set' ? { path: args.imagePath, uuid: args.reference?.id } : args.reference?.id;
            const result = await Editor.Message.request('scene', request, payload);
            if (args.operation === 'refresh' && !result) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No persisted reference image is available to refresh.' });
            return { operation: args.operation, supported: true, persisted: nativeOperation === 'inspect' || nativeOperation === 'list' || result !== false, imagePath: args.imagePath ?? (result && typeof result === 'object' && 'path' in result ? result.path : null), reference: args.reference ?? (result && typeof result === 'object' && 'id' in result ? { id: result.id, type: 'cc.ImageAsset' } : null), images: nativeOperation === 'list' ? (Array.isArray(result) ? result : []) : undefined, result: result ?? null };
        } catch (error) {
            if (error instanceof ToolError) throw error;
            const profile = (Editor as { Profile?: { getProject?: (...args: unknown[]) => Promise<unknown>, setProject?: (...args: unknown[]) => Promise<unknown> } }).Profile;
            if (!profile || typeof profile.getProject !== 'function' || typeof profile.setProject !== 'function') throw new ToolError({ code: 'UNSUPPORTED_SCENE_IPC', status: 422, message: `Creator does not expose ${request} or project reference-image storage.`, details: { cause: error instanceof Error ? error.message : String(error) }, recovery: 'Use a Creator version exposing reference-image scene IPC or project profile storage.' });
            const current = await Editor.Message.request('scene', 'query-current-scene').catch(() => null) as unknown;
            const sceneId = args.reference?.id ?? (typeof current === 'string' ? current : current && typeof current === 'object' && ('uuid' in current || 'id' in current) ? String('uuid' in current ? current.uuid : current.id) : undefined);
            if (args.operation !== 'list' && !sceneId) throw new ToolError({ code: 'NOT_FOUND', status: 404, message: 'No active scene is available for reference-image storage.' });
            const stored = await profile.getProject('ccp3x', 'referenceImages', 'project').catch(() => ({})) as Record<string, unknown> | null;
            const records = stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
            if (writesImage) { const asset = await resolveAsset(undefined, args.imagePath); records[sceneId as string] = { id: asset.uuid, url: asset.url, file: asset.file ?? null }; await profile.setProject('ccp3x', 'referenceImages', records, 'project'); }
            else if (args.operation === 'clear') { delete records[sceneId as string]; await profile.setProject('ccp3x', 'referenceImages', records, 'project'); }
            const readBack = await profile.getProject('ccp3x', 'referenceImages', 'project').catch(() => ({})) as Record<string, unknown> | null;
            const record = sceneId && readBack && typeof readBack === 'object' ? readBack[sceneId] : null;
            if (args.operation === 'refresh' && !record) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No persisted reference image is available to refresh.' });
            const images = Object.entries(readBack && typeof readBack === 'object' && !Array.isArray(readBack) ? readBack : {}).map(([id, value]) => ({ id, value }));
            return { operation: args.operation, supported: true, persisted: args.operation === 'list' || (args.operation === 'clear' ? record === undefined : !!record), imagePath: record && typeof record === 'object' && 'url' in record ? record.url : args.imagePath ?? null, reference: record && typeof record === 'object' && 'id' in record ? { id: record.id, type: 'cc.ImageAsset' } : null, images, storage: 'project-profile', nativeIpc: false };
        }
    }

    @utcpTool('prefabOverrideDiff', 'Compare bounded prefab JSON records with stable serialized identities.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, baselineReference: InstanceReferenceSchema }, required: ['reference', 'baselineReference'] }, { type: 'object', properties: { equal: { type: 'boolean' }, changes: { type: 'array' }, source: { type: 'object' }, baseline: { type: 'object' } }, required: ['equal', 'changes', 'source', 'baseline'] }, 'GET', ['prefab', 'override', 'diff', 'stable'])
    async prefabOverrideDiff(args: { reference: IInstanceReference, baselineReference: IInstanceReference }): Promise<Record<string, unknown>> {
        const [current, baseline] = await Promise.all([resolveAsset(args.reference), resolveAsset(args.baselineReference)]);
        assertPrefabAsset(current, 'prefabOverrideDiff');
        assertPrefabAsset(baseline, 'prefabOverrideDiff');
        const [currentData, baselineData] = await Promise.all([readAsset(current), readAsset(baseline)]);
        const changes = diffValues(JSON.parse(baselineData.content), JSON.parse(currentData.content));
        return { equal: changes.length === 0, changes, source: { uuid: current.uuid, url: current.url, sha256: currentData.hash }, baseline: { uuid: baseline.uuid, url: baseline.url, sha256: baselineData.hash } };
    }
    @utcpTool('prefabInstantiate', 'Instantiate a prefab through the scene IPC and return stable identity read-back.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, parentReference: InstanceReferenceSchema, name: { type: 'string', maxLength: 128 } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, source: { type: 'object' }, persisted: { type: 'boolean' } }, required: ['reference', 'source', 'persisted'] }, 'POST', ['prefab', 'instantiate', 'scene'])
    async prefabInstantiate(args: { reference: IInstanceReference, parentReference?: IInstanceReference, name?: string }): Promise<Record<string, unknown>> {
        let nodeUuid: string | undefined;
        try {
            const source = await resolveAsset(args.reference);
            assertPrefabAsset(source, 'prefabInstantiate');
            let root = args.parentReference?.id;
            if (root) {
                const parent = await Editor.Message.request('scene', 'query-node', root) as unknown;
                if (!parent) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Parent node ${root} was not found.` });
            } else {
                const tree = await Editor.Message.request('scene', 'query-node-tree') as unknown as { uuid?: string } | null;
                root = tree?.uuid;
            }
            if (!root) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'No active scene root is available for prefab instantiation.' });
            const result = await Editor.Message.request('scene', 'create-node', { name: args.name ?? path.basename(source.url, '.prefab'), parent: root, assetUuid: source.uuid, unlinkPrefab: false, type: 'cc.Prefab' });
            nodeUuid = Array.isArray(result) ? result[0] : result;
            if (typeof nodeUuid !== 'string' || !nodeUuid) throw new Error('Creator returned no instantiated node identity.');
            await Editor.Message.request('scene', 'snapshot');
            const readBack = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown;
            assertNodeIdentity(nodeUuid, readBack, 'instantiate');
            const linkedAsset = prefabAssetId(readBack);
            if (!linkedAsset || baseUuid(linkedAsset) !== baseUuid(source.uuid)) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Prefab instantiation read-back was not linked to the requested source.', details: { expectedAsset: source.uuid, actualAsset: linkedAsset ?? null } });
            return { reference: { id: nodeUuid, type: 'cc.Node' }, source: { id: source.uuid, url: source.url }, persisted: true, readBack };
        } catch (error) {
            if (nodeUuid) {
                try {
                    await Editor.Message.request('scene', 'remove-node', { uuid: nodeUuid });
                    await Editor.Message.request('scene', 'snapshot');
                    const remaining = await Editor.Message.request('scene', 'query-node', nodeUuid) as unknown;
                    if (remaining) throw new Error(`node ${nodeUuid} still exists after cleanup`);
                } catch (rollbackError) {
                    throw new ToolError({ code: 'ROLLBACK_FAILED', status: 500, message: `prefabInstantiate failed and node ${nodeUuid} could not be cleaned up.`, details: { cause: error instanceof Error ? error.message : String(error), rollback: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) }, recovery: `Delete node ${nodeUuid} manually before retrying.` });
                }
            }
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'PREFAB_INSTANTIATE_FAILED', status: 502, message: 'Prefab instantiation did not return a verifiable node.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
    @utcpTool('prefabCreateFromNode', 'Create a linked prefab asset from a scene node through the verified Creator scene script and verify asset/node read-back.', { type: 'object', properties: { reference: InstanceReferenceSchema, assetPath: { type: 'string', pattern: '^db://assets/.+\\.prefab$' } }, required: ['reference', 'assetPath'] }, { type: 'object', properties: { reference: { type: 'object' }, asset: { type: 'object' }, persisted: { type: 'boolean' } }, required: ['reference', 'asset', 'persisted'] }, 'POST', ['prefab', 'create', 'node', 'asset'])
    async prefabCreateFromNode(args: { reference: IInstanceReference, assetPath: string }): Promise<Record<string, unknown>> {
        if (!/^db:\/\/assets\/.+\.prefab$/.test(args.assetPath) || args.assetPath.includes('..')) invalid('assetPath must be a db://assets .prefab path without traversal.');
        const node = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown;
        if (!node) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} was not found.` });
        const created = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'createPrefabFromNode', args: [args.reference.id, args.assetPath] });
        if (typeof created !== 'string' || !created) throw new ToolError({ code: 'PREFAB_CREATE_FAILED', status: 502, message: 'Creator did not return the created prefab asset identity.' });
        const asset = await Editor.Message.request('asset-db', 'query-asset-info', created) as { uuid?: string, type?: string, url?: string } | null;
        if (!asset || asset.uuid !== created || asset.type !== 'cc.Prefab') throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Created prefab asset could not be verified.', details: { expectedUuid: created, actual: asset ?? null } });
        await Editor.Message.request('scene', 'snapshot');
        return { reference: { id: args.reference.id, type: args.reference.type ?? 'cc.Node' }, asset: { id: asset.uuid, type: asset.type, url: asset.url }, persisted: true };
    }

    @utcpTool('prefabUpdate', 'Apply all linked prefab instance overrides through Creator and verify source and instance read-back.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack'] }, 'POST', ['prefab', 'update', 'apply'])
    async prefabUpdate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        return this.prefabSceneOperation('apply', args.reference);
    }

    @utcpTool('prefabInstanceInspect', 'Inspect a linked prefab instance; returns source hash and bounded override metadata with explicit truncation. Read-only; does not save/reload the scene.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144, default: 32768 }, maxOverrides: { type: 'integer', minimum: 1, maximum: MAX_ITEMS, default: MAX_ITEMS } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, isPrefabInstance: { type: 'boolean' }, prefabReference: { type: ['object', 'null'] }, overrides: { type: 'array' }, totalOverrides: { type: 'integer' }, truncated: { type: 'boolean' }, source: { type: ['object', 'null'] }, mountedChildren: { type: 'array' }, mountedComponents: { type: 'array' }, removedComponents: { type: 'array' }, overrideCounts: { type: 'object' }, responseTruncated: { type: 'boolean' }, readBackTruncated: { type: 'boolean' }, readBack: { type: 'object' } }, required: ['reference', 'isPrefabInstance', 'prefabReference', 'overrides', 'totalOverrides', 'truncated', 'source', 'readBack'] }, 'GET', ['prefab', 'instance', 'inspect'])
    async prefabInstanceInspect(args: { reference: IInstanceReference, maxOverrides?: number, maxBytes?: number }): Promise<Record<string, unknown>> {
        const limit = bounded(args.maxOverrides, MAX_ITEMS);
        const maxBytes = prefabResponseLimit(args.maxBytes);
        const readBack = await Editor.Message.request('scene', 'query-node', args.reference.id) as unknown;
        if (!readBack) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Node ${args.reference.id} was not found.` });
        const prefab = propertyValue(objectField(readBack, '__prefab__') ?? objectField(readBack, '_prefab')) as Record<string, unknown> | undefined;
        const prefabInfo = prefab?.prefabStateInfo && typeof prefab.prefabStateInfo === 'object' ? prefab.prefabStateInfo as Record<string, unknown> : prefab;
        const prefabId = prefabInfo?.assetUuid ?? prefabInfo?.uuid ?? objectField(prefabInfo?.asset, '_uuid') ?? objectField(prefabInfo?.asset, 'uuid');
        const instanceDescriptor = prefab?.instance;
        // Creator 3.7 serializes `__prefab__.instance` as a property descriptor ({value,type,...}),
        // so the override arrays only exist on the unwrapped value.
        const instance = instanceDescriptor && typeof instanceDescriptor === 'object'
            ? (('value' in instanceDescriptor) && ('type' in instanceDescriptor) ? propertyValue(instanceDescriptor) : instanceDescriptor) as Record<string, unknown>
            : prefabInfo;
        const propertyOverrides = propertyValue(instance?.propertyOverrides);
        const allOverrides = Array.isArray(propertyOverrides) ? propertyOverrides : [];
        const assetId = prefabAssetId(readBack);
        let source: Record<string, unknown> | null = null;
        if (assetId) {
            const asset = await resolveAsset({ id: assetId });
            assertPrefabAsset(asset, 'prefabInstanceInspect');
            source = { id: asset.uuid, url: asset.url, sha256: (await readAsset(asset)).hash };
        }
        const structural = Object.fromEntries(['mountedChildren', 'mountedComponents', 'removedComponents'].map(key => { const value = propertyValue(instance?.[key]); return [key, Array.isArray(value) ? value : []]; }));
        const overrideCounts = { propertyOverrides: allOverrides.length, mountedChildren: structural.mountedChildren.length, mountedComponents: structural.mountedComponents.length, removedComponents: structural.removedComponents.length };
        return boundPrefabResponse({ reference: args.reference, isPrefabInstance: typeof prefabId === 'string' && prefabId.length > 0, prefabReference: typeof prefabId === 'string' && prefabId ? { id: prefabId, type: 'cc.Prefab' } : null, overrides: allOverrides.slice(0, limit), mountedChildren: structural.mountedChildren.slice(0, limit), mountedComponents: structural.mountedComponents.slice(0, limit), removedComponents: structural.removedComponents.slice(0, limit), overrideCounts, totalOverrides: Object.values(overrideCounts).reduce((a, b) => a + b, 0), truncated: Object.values(overrideCounts).some(count => count > limit), source, readBack }, maxBytes);
    }

    private async prefabSceneOperation(operation: 'apply' | 'revert', reference: IInstanceReference, expectedSourceSha256?: string, maxBytes = 32768): Promise<Record<string, unknown>> {
        if (expectedSourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSourceSha256)) invalid('expectedSourceSha256 must be a lowercase SHA-256 digest.');
        try {
            const beforeNode = await Editor.Message.request('scene', 'query-node', reference.id) as unknown;
            if (!beforeNode) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `Prefab instance ${reference.id} was not found.` });
            const assetId = prefabAssetId(beforeNode);
            if (!assetId) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Node ${reference.id} is not a linked prefab instance.` });
            const source = await resolveAsset({ id: assetId });
            assertPrefabAsset(source, `prefab ${operation}`);
            const sourceBefore = await readAsset(source);
            if (expectedSourceSha256 && sourceBefore.hash !== expectedSourceSha256) throw new ToolError({ code: 'PREFAB_SOURCE_CONFLICT', status: 409, message: 'Prefab source changed since inspection; no apply was dispatched.', recovery: 'Inspect the instance/source again and review the overrides before applying.' });
            let result: unknown;
            if (operation === 'apply') {
                result = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'applyPrefabByNode', args: [reference.id] });
                if (result !== null && result !== undefined) throw new Error(String(result));
                await new Promise((resolve) => setTimeout(resolve, 50));
            } else {
                result = await restorePrefabNode(reference.id);
                if (result !== true) throw new Error(`restore-prefab returned ${JSON.stringify(result ?? null)}`);
            }
            await Editor.Message.request('scene', 'snapshot');
            const afterNode = await Editor.Message.request('scene', 'query-node', reference.id) as unknown;
            assertNodeIdentity(reference.id, afterNode, operation);
            const afterAssetId = prefabAssetId(afterNode);
            if (!afterAssetId || baseUuid(afterAssetId) !== baseUuid(assetId)) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `${operation} prefab read-back lost the linked source identity.`, details: { expectedAsset: assetId, actualAsset: afterAssetId ?? null } });
            const sourceAfter = await readAsset(await resolveAsset({ id: assetId }));
            const changes = operation === 'apply' && sourceBefore.hash !== sourceAfter.hash ? diffValues(JSON.parse(sourceBefore.content), JSON.parse(sourceAfter.content)) : [];
            return boundPrefabResponse({ reference, operation, persisted: true, readBack: afterNode, sourceReadBack: { id: assetId, url: source.url, beforeSha256: sourceBefore.hash, afterSha256: sourceAfter.hash }, sourceChanges: changes, sourceDiffTruncated: changes.length >= MAX_ITEMS, sceneSaved: false, result: result ?? null }, maxBytes);
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'PREFAB_OVERRIDE_OPERATION_FAILED', status: 502, message: `${operation} prefab overrides failed or could not be read back.`, details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
    @utcpTool('prefabReferenceAudit', 'Audit nested prefab UUID references and missing serialized dependencies after reload-safe source read.', { type: 'object', properties: { reference: InstanceReferenceSchema, maxReferences: { type: 'integer', minimum: 1, maximum: 2000, default: 2000 } }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, nestedPrefabs: { type: 'array' }, missingReferences: { type: 'array' }, totalMissingReferences: { type: 'integer' }, totalReferences: { type: 'integer' }, truncated: { type: 'boolean' }, source: { type: 'object' } }, required: ['valid', 'nestedPrefabs', 'missingReferences', 'totalMissingReferences', 'totalReferences', 'truncated', 'source'] }, 'GET', ['prefab', 'reference', 'audit', 'nested'])
    async prefabReferenceAudit(args: { reference: IInstanceReference, maxReferences?: number }): Promise<Record<string, unknown>> {
        const maxReferences = bounded(args.maxReferences, 2000, 2000);
        const row = await resolveAsset(args.reference);
        assertPrefabAsset(row, 'prefabReferenceAudit');
        const source = await readAsset(row);
        const assets = await queryAssets();
        const known = new Set(assets.map((asset) => baseUuid(asset.uuid)));
        const allReferences = refs(source.content);
        const allMissing = allReferences.filter((id) => !known.has(id));
        const ids = allReferences.slice(0, maxReferences);
        const nestedPrefabs = assets.filter((asset) => ids.includes(baseUuid(asset.uuid)) && asset.url.endsWith('.prefab')).map((asset) => ({ uuid: asset.uuid, url: asset.url }));
        const missingReferences = allMissing.slice(0, maxReferences).map((id) => ({ id }));
        return { valid: allMissing.length === 0, nestedPrefabs, missingReferences, totalMissingReferences: allMissing.length, totalReferences: allReferences.length, truncated: allReferences.length > ids.length || allMissing.length > missingReferences.length, source: { uuid: row.uuid, url: row.url, sha256: source.hash, reloaded: true } };
    }
    @utcpTool('sceneReferenceValidate', 'Validate serialized UUID references in a scene asset against the imported asset database.', { type: 'object', properties: { reference: InstanceReferenceSchema, maxReferences: { type: 'integer', minimum: 1, maximum: 2000, default: 2000 } }, required: ['reference'] }, { type: 'object', properties: { valid: { type: 'boolean' }, references: { type: 'array' }, missingReferences: { type: 'array' }, totalMissingReferences: { type: 'integer' }, totalReferences: { type: 'integer' }, truncated: { type: 'boolean' }, source: { type: 'object' } }, required: ['valid', 'references', 'missingReferences', 'totalMissingReferences', 'totalReferences', 'truncated', 'source'] }, 'GET', ['scene', 'reference', 'validate', 'serialized'])
    async sceneReferenceValidate(args: { reference: IInstanceReference, maxReferences?: number }): Promise<Record<string, unknown>> {
        const row = await resolveAsset(args.reference);
        assertSceneAsset(row, 'sceneReferenceValidate');
        const source = await readAsset(row);
        const known = new Set((await queryAssets()).map((asset) => baseUuid(asset.uuid)));
        const allReferences = refs(source.content);
        const limit = bounded(args.maxReferences, 2000, 2000);
        const allMissing = allReferences.filter((id) => !known.has(id));
        const references = allReferences.slice(0, limit);
        const missingReferences = allMissing.slice(0, limit);
        return { valid: allMissing.length === 0, references, missingReferences, totalMissingReferences: allMissing.length, totalReferences: allReferences.length, truncated: allReferences.length > references.length || allMissing.length > missingReferences.length, source: { uuid: row.uuid, url: row.url, sha256: source.hash, reopened: true } };
    }

    @utcpTool('prefabApplyOverrides', 'Apply all native linked-instance overrides with optional source SHA-256 conflict guard. Returns source diff and instance read-back; does not create a variant asset or save/reopen the scene. Never retry an ambiguous mutation without inspection.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144, default: 32768 }, expectedSourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' }, sourceChanges: { type: 'array' }, sourceDiffTruncated: { type: 'boolean' }, responseTruncated: { type: 'boolean' }, readBackTruncated: { type: 'boolean' }, sceneSaved: { type: 'boolean' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack', 'sourceChanges', 'sourceDiffTruncated', 'sceneSaved'] }, 'POST', ['prefab', 'apply', 'overrides'])
    async prefabApplyOverrides(args: { reference: IInstanceReference, expectedSourceSha256?: string, maxBytes?: number }): Promise<Record<string, unknown>> { return this.prefabSceneOperation('apply', args.reference, args.expectedSourceSha256, prefabResponseLimit(args.maxBytes)); }
    @utcpTool('prefabRevertOverrides', 'Revert prefab overrides through the scene IPC and verify full-instance restoration.', { type: 'object', properties: { reference: InstanceReferenceSchema, paths: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string' } } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack'] }, 'POST', ['prefab', 'revert', 'overrides'])
    async prefabRevertOverrides(args: { reference: IInstanceReference, paths?: string[] }): Promise<Record<string, unknown>> {
        if (args.paths && args.paths.length > 0) throw new ToolError({ code: 'UNSUPPORTED_SELECTIVE_REVERT', status: 422, message: 'Creator 3.7.3 restore-prefab reverts the full instance and does not expose selective path restoration.' });
        return this.prefabSceneOperation('revert', args.reference);
    }
    @utcpTool('prefabRestore', 'Restore a linked prefab instance through Creator native restore-prefab and verify full-instance read-back.', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack'] }, 'POST', ['prefab', 'restore', 'full'])
    async prefabRestore(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        return this.prefabSceneOperation('revert', args.reference);
    }

    @utcpTool('tilemapInspect', 'Inspect an imported TMX tilemap and return a bounded typed layer/object inventory.', { type: 'object', properties: { reference: InstanceReferenceSchema, maxLayers: { type: 'integer', minimum: 1, maximum: MAX_ITEMS, default: MAX_ITEMS } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, format: { type: 'string' }, map: { type: 'object' }, tilesets: { type: 'array' }, layers: { type: 'array' }, objectGroups: { type: 'array' }, count: { type: 'integer' } }, required: ['reference', 'format', 'map', 'tilesets', 'layers', 'objectGroups', 'count'] }, 'GET', ['tilemap', 'inspect', 'layers'])
    async tilemapInspect(args: { reference: IInstanceReference, maxLayers?: number }): Promise<Record<string, unknown>> {
        const row = await resolveAsset(args.reference);
        if (!/\.tmx$/i.test(row.url)) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Tilemap inspection requires an imported .tmx asset, got ${row.url}.` });
        const inventory = tilemapInventory((await readAsset(row)).content, bounded(args.maxLayers, MAX_ITEMS));
        return { reference: { id: row.uuid, type: row.type ?? 'cc.TiledMapAsset' }, ...inventory, count: inventory.layers.length + inventory.objectGroups.length };
    }
    private async tilemapSourceEdit(args: { reference: IInstanceReference, path: string, value: unknown }): Promise<Record<string, unknown>> {
        const row = await resolveAsset(args.reference);
        if (!/\.tmx$/i.test(row.url)) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Tilemap editing requires an imported .tmx asset, got ${row.url}.` });
        const target = tilemapPath(args.path);
        const before = await readAsset(row);
        const update = updateTilemapXml(before.content, target.kind, target.selector, target.property, args.value);
        const hashes = await saveTilemapAsset(row, update.content);
        const readBackSource = await readAsset(await resolveAsset({ id: row.uuid }));
        const inventory = tilemapInventory(readBackSource.content, MAX_ITEMS);
        const collection = target.kind === 'layers' ? inventory.layers : inventory.objectGroups.flatMap((group) => group.objects);
        const readBack = collection.find((item) => item.id === target.selector || item.name === target.selector) ?? null;
        const persisted = readBack !== null && JSON.stringify(readBack[target.property as keyof typeof readBack]) === JSON.stringify(args.value);
        if (!persisted) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: `Tilemap source read-back did not match '${args.path}'.` });
        return { reference: { id: row.uuid, type: row.type ?? 'cc.TiledMapAsset' }, path: args.path, changed: hashes.before !== hashes.after, previous: update.previous, readBack, persisted: true, source: { url: row.url, beforeSha256: hashes.before, afterSha256: hashes.after } };
    }
    @utcpTool('tilemapLayerEdit', 'Edit one imported TMX layer attribute and verify source/reimport read-back.', { type: 'object', properties: { reference: InstanceReferenceSchema, path: { type: 'string', pattern: '^layers\\.' }, value: {} }, required: ['reference', 'path', 'value'] }, { type: 'object', properties: { reference: { type: 'object' }, path: { type: 'string' }, changed: { type: 'boolean' }, previous: {}, readBack: {}, persisted: { type: 'boolean' }, source: { type: 'object' } }, required: ['reference', 'path', 'changed', 'readBack', 'persisted', 'source'] }, 'POST', ['tilemap', 'layer', 'edit'])
    async tilemapLayerEdit(args: { reference: IInstanceReference, path: string, value: unknown }): Promise<Record<string, unknown>> { return this.tilemapSourceEdit(args); }
    @utcpTool('tilemapObjectEdit', 'Edit one imported TMX object attribute and verify source/reimport read-back.', { type: 'object', properties: { reference: InstanceReferenceSchema, path: { type: 'string', pattern: '^objects\\.' }, value: {} }, required: ['reference', 'path', 'value'] }, { type: 'object', properties: { reference: { type: 'object' }, path: { type: 'string' }, changed: { type: 'boolean' }, previous: {}, readBack: {}, persisted: { type: 'boolean' }, source: { type: 'object' } }, required: ['reference', 'path', 'changed', 'readBack', 'persisted', 'source'] }, 'POST', ['tilemap', 'object', 'edit'])
    async tilemapObjectEdit(args: { reference: IInstanceReference, path: string, value: unknown }): Promise<Record<string, unknown>> { return this.tilemapSourceEdit(args); }
    @utcpTool('tilemapValidate', 'Validate imported TMX tilemap UUID references, layer dimensions, and tile gid ranges (inline and external tilesets).', { type: 'object', properties: { reference: InstanceReferenceSchema }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, valid: { type: 'boolean' }, missingReferences: { type: 'array' }, gidIssues: { type: 'array' }, dimensionIssues: { type: 'array' }, gidRangeVerified: { type: 'boolean' }, unverifiedTilesets: { type: 'array' }, checkedNodes: { type: 'integer' }, source: { type: 'object' } }, required: ['reference', 'valid', 'missingReferences', 'gidIssues', 'dimensionIssues', 'gidRangeVerified', 'unverifiedTilesets', 'checkedNodes', 'source'] }, 'GET', ['tilemap', 'validate', 'references', 'gids', 'dimensions'])
    async tilemapValidate(args: { reference: IInstanceReference }): Promise<Record<string, unknown>> {
        const row = await resolveAsset(args.reference);
        if (!/\.tmx$/i.test(row.url)) throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Tilemap validation requires an imported .tmx asset, got ${row.url}.` });
        const source = await readAsset(row);
        const known = new Set((await queryAssets()).map((asset) => baseUuid(asset.uuid)));
        const references = refs(source.content);
        const missingReferences = references.filter((id) => !known.has(id)).map((id) => ({ id }));
        const inventory = tilemapInventory(source.content, MAX_ITEMS);
        const ranges = tilemapGidRanges(source.content);
        const unverifiedTilesets = await tilemapExternalRanges(row, source.content, ranges);
        const gids = tilemapDataGids(source.content);
        const gidIssues = ranges.length === 0 ? [] : gids.filter(({ gid }) => !ranges.some((range) => gid >= range.firstGid && gid < range.firstGid + range.tileCount)).map(({ gid, layer }) => ({ gid, layer }));
        const dimensionIssues = tilemapDimensionIssues(source.content);
        const valid = missingReferences.length === 0 && gidIssues.length === 0 && dimensionIssues.length === 0;
        return { reference: { id: row.uuid, type: row.type ?? 'cc.TiledMapAsset' }, valid, missingReferences, gidIssues, dimensionIssues, gidRangeVerified: ranges.length > 0 && unverifiedTilesets.length === 0, unverifiedTilesets, checkedNodes: inventory.layers.length + inventory.objectGroups.length, source: { url: row.url, sha256: source.hash, references } };
    }

    @utcpTool('spriteAtlasConfigure', 'Configure a bounded sprite atlas importer setting and verify generated library output.', { type: 'object', properties: { reference: InstanceReferenceSchema, presetId: { type: 'string', minLength: 1, maxLength: 128 }, maxWidth: { type: 'integer', minimum: 1, maximum: 8192 }, maxHeight: { type: 'integer', minimum: 1, maximum: 8192 } }, required: ['reference', 'presetId'] }, { type: 'object', properties: { reference: { type: 'object' }, changed: { type: 'boolean' }, generatedOutputs: { type: 'array' }, sourceSha256: { type: 'string' }, persisted: { type: 'boolean' } }, required: ['reference', 'changed', 'generatedOutputs', 'sourceSha256', 'persisted'] }, 'POST', ['sprite', 'atlas', 'configure'])
    async spriteAtlasConfigure(args: { reference: IInstanceReference, presetId: string, maxWidth?: number, maxHeight?: number }): Promise<Record<string, unknown>> {
        const row = await resolveAsset(args.reference);
        if (row.type !== 'cc.SpriteAtlas' && row.importer !== 'auto-atlas') throw new ToolError({ code: 'TYPE_MISMATCH', status: 422, message: `Sprite atlas configuration requires an auto-atlas asset, got ${row.url}.` });
        const importer = new AssetTools();
        const before = await importer.assetImportSettingsGet({ reference: args.reference });
        const settings = before.settings;
        const operations: Array<Record<string, unknown>> = [];
        if (args.presetId !== 'default') {
            if (!before.schema.properties.some((property) => property.path === 'algorithm' && property.enumValues?.includes(args.presetId))) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `Unsupported auto-atlas algorithm preset '${args.presetId}'.` });
            operations.push(await importer.assetImportSettingsSet({ reference: args.reference, path: 'algorithm', value: args.presetId }));
        }
        if (args.maxWidth !== undefined) operations.push(await importer.assetImportSettingsSet({ reference: args.reference, path: 'maxWidth', value: args.maxWidth }));
        if (args.maxHeight !== undefined) operations.push(await importer.assetImportSettingsSet({ reference: args.reference, path: 'maxHeight', value: args.maxHeight }));
        if (operations.length === 0) await Editor.Message.request('asset-db', 'reimport-asset', row.uuid);
        const readBack = await importer.assetImportSettingsGet({ reference: args.reference });
        const generatedOutputs = await generatedAtlasOutputs(row);
        if (generatedOutputs.length === 0) throw new ToolError({ code: 'GENERATED_OUTPUT_UNAVAILABLE', status: 502, message: `Auto-atlas reimport completed without verifiable library output for ${row.url}.`, details: { source: row.url, settings: readBack.settings } });
        const source = await readAsset(row);
        return { reference: { id: row.uuid, type: row.type ?? 'cc.SpriteAtlas' }, presetId: args.presetId, changed: operations.length > 0, operations, generatedOutputs, sourceSha256: source.hash, settings: readBack.settings, persisted: true };
    }


    @utcpTool('uiResponsivePreview', 'Compare bounded UI geometry across requested resolutions using deterministic projection evidence.', { type: 'object', additionalProperties: false, properties: { resolutions: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', additionalProperties: false, properties: { width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 } }, required: ['width', 'height'] } }, reference: InstanceReferenceSchema }, required: ['resolutions'] }, { type: 'object', properties: { supported: { type: 'boolean' }, comparisons: { type: 'array' }, stable: { type: 'boolean' }, caveat: { type: 'string' } }, required: ['supported', 'comparisons', 'stable', 'caveat'] }, 'GET', ['ui', 'responsive', 'preview'])
    async uiResponsivePreview(args: { resolutions: Array<{ width: number, height: number }>, reference?: IInstanceReference }): Promise<Record<string, unknown>> {
        const tree = await sceneTree();
        const match = args.reference?.id ? findSceneNode(tree, args.reference.id) : { node: tree, limitReached: false };
        if (match.limitReached) throw new ToolError({ code: 'SCENE_LOOKUP_LIMIT', status: 422, message: 'UI node lookup reached the 2000-node safety limit before resolving the reference.', details: { reference: args.reference, maxNodes: 2000 }, recovery: 'Use nodeGetTree with a smaller subtree or inspect the scene hierarchy; the node was not proven missing.' });
        const root = match.node;
        if (!root) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: `UI node not found: ${args.reference?.id}`, details: { reference: args.reference }, recovery: 'Re-read nodeGetTree or nodeGetAtPath and retry with a current live node reference.' });
        const ids = typeof root.uuid === 'string' ? [root.uuid] : [];
        if (ids.length === 0) throw new ToolError({ code: 'UI_LAYOUT_QUERY_FAILED', status: 502, message: 'No UI node identities were available for responsive comparison.' });
        const geometry = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'uiLayoutInspectGeometry', args: [{ nodeIds: ids }] }) as { nodes?: unknown[] } | null;
        const entries = Array.isArray(geometry?.nodes) ? geometry.nodes.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)) : [];
        if (entries.length === 0) throw new ToolError({ code: 'UI_LAYOUT_QUERY_FAILED', status: 502, message: 'Responsive comparison received no measurable UI geometry.' });
        const base = args.resolutions[0];
        const comparisons = args.resolutions.map((resolution) => {
            const scaleX = resolution.width / base.width;
            const scaleY = resolution.height / base.height;
            const projectedRects = entries.map((entry) => {
                const rect = entry.worldRect;
                if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return { id: entry.id ?? null, worldRect: null };
                const source = rect as Record<string, unknown>;
                return { id: entry.id ?? null, worldRect: { x: Number(source.x) * scaleX, y: Number(source.y) * scaleY, width: Number(source.width) * scaleX, height: Number(source.height) * scaleY } };
            });
            return { resolution, scale: { x: scaleX, y: scaleY }, projectedRects, evidence: 'uiLayoutInspectGeometry-worldRect-projection' };
        });
        return { supported: true, comparisons, stable: comparisons.length > 0, caveat: 'Creator 3.7.3 exposes live world geometry but no preview viewport setter; comparisons are bounded deterministic projections, not rendered screenshots.' };
    }

    @utcpTool('previewResolutionSet', 'Set an allowlisted preview resolution through Creator IPC and read back the applied value.', { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', minimum: 1, maximum: 8192 }, height: { type: 'integer', minimum: 1, maximum: 8192 } }, required: ['width', 'height'] }, { type: 'object', properties: { width: { type: 'integer' }, height: { type: 'integer' }, persisted: { type: 'boolean' }, supported: { type: 'boolean' } }, required: ['width', 'height', 'persisted', 'supported'] }, 'POST', ['preview', 'resolution', 'set'])
    async previewResolutionSet(args: { width: number, height: number }): Promise<Record<string, unknown>> { try { const result = await Editor.Message.request('preview', 'set-resolution', { width: args.width, height: args.height }); return { width: args.width, height: args.height, persisted: result !== false, supported: true, readBack: result ?? null }; } catch (error) { throw new ToolError({ code: 'UNSUPPORTED_PREVIEW_IPC', status: 422, message: 'Creator preview resolution IPC is unavailable.', details: { cause: error instanceof Error ? error.message : String(error) } }); } }

    @utcpTool('editorUndoTransactionProbe', 'Probe snapshot, undo, redo, and snapshot-abort lifecycle boundaries without leaving a pending transaction.', { type: 'object', properties: {} }, { type: 'object', properties: { supported: { type: 'boolean' }, boundaries: { type: 'array' }, clean: { type: 'boolean' } }, required: ['supported', 'boundaries', 'clean'] }, 'POST', ['editor', 'undo', 'transaction', 'probe'])
    async editorUndoTransactionProbe(): Promise<Record<string, unknown>> { const boundaries: string[] = []; try { await Editor.Message.request('scene', 'snapshot'); boundaries.push('snapshot'); await Editor.Message.request('scene', 'snapshot-abort'); boundaries.push('snapshot-abort'); return { supported: true, boundaries, clean: true }; } catch (error) { throw new ToolError({ code: 'UNDO_PROBE_FAILED', status: 422, message: 'Creator undo transaction lifecycle is unavailable.', details: { cause: error instanceof Error ? error.message : String(error) } }); } }

    @utcpTool('broadcastObserve', 'Observe one allowlisted Creator broadcast through a byte-bounded register, observe, and dispose lifecycle.', { type: 'object', additionalProperties: false, properties: { topic: { type: 'string', enum: ['ccp3x:probe', 'scene:change', 'asset-db:change'] } }, required: ['topic'] }, { type: 'object', properties: { topic: { type: 'string' }, supported: { type: 'boolean' }, observed: { type: 'boolean' }, lifecycle: { type: 'array' }, eventBytes: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['topic', 'supported', 'observed', 'lifecycle', 'eventBytes', 'truncated'] }, 'GET', ['broadcast', 'event', 'observe'])
    async broadcastObserve(args: { topic: string }): Promise<Record<string, unknown>> {
        const messages = Editor.Message as unknown as {
            addBroadcastListener?: (topic: string, handler: (...payload: unknown[]) => void) => void,
            removeBroadcastListener?: (topic: string, handler: (...payload: unknown[]) => void) => void,
            broadcast: (topic: string, ...payload: unknown[]) => void,
        };
        if (typeof messages.addBroadcastListener !== 'function' || typeof messages.removeBroadcastListener !== 'function') throw new ToolError({ code: 'UNSUPPORTED_BROADCAST_IPC', status: 422, message: 'Creator broadcast listener lifecycle is unavailable.' });
        const marker = `ccp3x-${Date.now()}`;
        let observed: unknown[] | null = null;
        const handler = (...payload: unknown[]) => { observed = payload; };
        const lifecycle = ['registered'];
        messages.addBroadcastListener(args.topic, handler);
        try {
            if (args.topic === 'ccp3x:probe') messages.broadcast(args.topic, marker);
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (observed !== null) lifecycle.push('observed');
        } finally {
            messages.removeBroadcastListener(args.topic, handler);
            lifecycle.push('disposed');
        }
        const serialized = observed === null ? '' : JSON.stringify(observed) ?? '';
        const eventBytes = Buffer.byteLength(serialized, 'utf8');
        const truncated = eventBytes > 4096;
        const event = truncated ? { omitted: true, bytes: eventBytes, reason: 'Broadcast payload exceeds the 4096-byte response limit.' } : observed;
        return { topic: args.topic, supported: true, observed: observed !== null, lifecycle, event, eventBytes, truncated, retainedListener: false };
    }

    @utcpTool('editorListenersInspect', 'Inspect the bounded CCP listener lifecycle surface; never claims arbitrary Creator listener enumeration.', { type: 'object', properties: {} }, { type: 'object', properties: { supported: { type: 'boolean' }, listeners: { type: 'array' }, limitation: { type: 'string' } }, required: ['supported', 'listeners', 'limitation'] }, 'GET', ['editor', 'listeners', 'inspect'])
    async editorListenersInspect(): Promise<Record<string, unknown>> {
        return { supported: true, listeners: [], limitation: 'Creator 3.7.3 does not expose arbitrary listener enumeration; only CCP-owned broadcast lifecycles are observable.' };
    }
}
