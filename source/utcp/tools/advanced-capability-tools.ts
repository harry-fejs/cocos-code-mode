import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { InstanceReferenceSchema, IInstanceReference } from '../schemas';
import { ToolError } from '../tool-error';
import { AssetTools } from './asset-tools';
import type { AssetImportSettingsSetResult } from './asset-tools';
import { restorePrefabNode } from '../utils/tools-utils';
import { boundPrefabResponse, prefabResponseLimit } from '../utils/prefab-response';
import { requireCreator38 } from '../utils/creator38-capability';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@[A-Za-z0-9_-]+)?/gi;
const SERIALIZED_LIMIT = 5 * 1024 * 1024;
const MAX_ITEMS = 128;
const broadcastListeners = new Map<(...payload: unknown[]) => void, { topic: string; state: 'registered' | 'removal-failed' }>();

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

type RemovedSelection = { nodeUUID: string, fileID: string, localID: string[], descriptor: unknown };
function prefabInstanceData(node: unknown): Record<string, unknown> | undefined {
    const prefab = propertyValue(objectField(node, '__prefab__') ?? objectField(node, '_prefab') ?? objectField(node, 'prefab'));
    const instance = propertyValue(objectField(prefab, 'instance') ?? objectField(node, '_prefabInstance')) as unknown;
    return instance && typeof instance === 'object' && !Array.isArray(instance) ? instance as Record<string, unknown> : undefined;
}
function prefabArray(value: unknown): unknown[] {
    const array = propertyValue(value);
    return Array.isArray(array) ? array.map(propertyValue) : [];
}
function removedPath(entry: unknown): string[] | undefined {
    const value = propertyValue(entry);
    const localID = prefabArray(objectField(value, 'localID') ?? objectField(objectField(value, 'targetInfo'), 'localID'));
    return localID.length && localID.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512) ? localID as string[] : undefined;
}
function selectRemovedComponent(node: unknown, fileID: string): RemovedSelection {
    const nodeUUID = nodeIdentity(node);
    const entries = prefabArray(objectField(node, 'removedComponents'));
    const matching = entries.filter(entry => propertyValue(objectField(entry, 'fileID')) === fileID);
    if (!nodeUUID || matching.length !== 1) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'fileID must identify exactly one authoritative removed component on the inspected node; no mutation was dispatched.' });
    const entry = matching[0];
    const declaredNode = propertyValue(objectField(entry, 'nodeUUID') ?? objectField(entry, 'nodeUuid'));
    if (declaredNode !== undefined && declaredNode !== nodeUUID) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component descriptor belongs to another node; no mutation was dispatched.' });
    const raw = prefabArray(prefabInstanceData(node)?.removedComponents);
    const paths = raw.map(removedPath).filter((ids): ids is string[] => !!ids && ids[ids.length - 1] === fileID);
    const explicit = removedPath(entry);
    if (explicit && explicit[explicit.length - 1] !== fileID) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed descriptor fileID and nested target disagree; no mutation was dispatched.' });
    if ((!explicit && paths.length > 1) || (explicit && paths.length > 0 && !paths.some(ids => equalPrefabValue(ids, explicit)))) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component fileID has ambiguous or inconsistent nested paths; no mutation was dispatched.' });
    if (raw.some(entry => !!removedPath(entry)) && !explicit && !paths.length) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component is not present in the inspected prefab override descriptors; no mutation was dispatched.' });
    // Never invent a native selector by joining localID. Creator's node dump supplies the exact facade fileID.
    return { nodeUUID, fileID, localID: explicit ?? paths[0] ?? [fileID], descriptor: entry };
}
type RemovedInspection = { nodeUUID: string, fileID: string, instanceRootUUID: string, rootSourceAssetUUID: string, selected: { localID: string[], sourceAssetUUID: string, ownerFileID: string, componentType: string } | null, removedComponents: string[][] };
async function inspectRemovedComponent(nodeUUID: string, fileID: string): Promise<RemovedInspection> {
    const result = await Editor.Message.request('scene', 'execute-scene-script', { name: 'ccp3x', method: 'inspectRemovedPrefabComponent', args: [{ nodeUuid: nodeUUID, fileID }] }) as unknown;
    const instanceRootUUID = objectField(result, 'instanceRootUUID'), rootSourceAssetUUID = objectField(result, 'rootSourceAssetUUID');
    const removed = objectField(result, 'removedComponents');
    if (objectField(result, 'nodeUUID') !== nodeUUID || objectField(result, 'fileID') !== fileID || typeof instanceRootUUID !== 'string' || !instanceRootUUID || typeof rootSourceAssetUUID !== 'string' || !rootSourceAssetUUID || !Array.isArray(removed) || removed.length > MAX_ITEMS) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Raw prefab removal inspection returned invalid identities or exceeds the bound.' });
    const removedComponents = removed.map(removedPath);
    if (removedComponents.some(ids => !ids)) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Raw prefab removal inspection returned an invalid nested descriptor.' });
    const selectedValue = objectField(result, 'selected');
    let selected: RemovedInspection['selected'] = null;
    if (selectedValue !== null) {
        const localID = removedPath(selectedValue), sourceAssetUUID = objectField(selectedValue, 'sourceAssetUUID'), ownerFileID = objectField(selectedValue, 'ownerFileID'), componentType = objectField(selectedValue, 'componentType');
        if (!localID || localID[localID.length - 1] !== fileID || typeof sourceAssetUUID !== 'string' || !sourceAssetUUID || typeof ownerFileID !== 'string' || !ownerFileID || typeof componentType !== 'string' || !componentType || removedComponents.filter(ids => equalPrefabValue(ids, localID)).length !== 1) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Raw selected removal is foreign or ambiguous.' });
        selected = { localID, sourceAssetUUID, ownerFileID, componentType };
    }
    return { nodeUUID, fileID, instanceRootUUID, rootSourceAssetUUID, selected, removedComponents: removedComponents as string[][] };
}
function equalPrefabValue(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const left = Object.keys(a), right = Object.keys(b);
    return left.length === right.length && left.every(key => Object.prototype.hasOwnProperty.call(b, key) && equalPrefabValue(objectField(a, key), objectField(b, key)));
}
type PrefabRecord = Record<string, unknown>;
type PrefabComponent = { component: PrefabRecord, index: number, owner: PrefabRecord };
type PrefabSourceDocument = { asset: AssetRow, content: string, hash: string, records: PrefabRecord[] };
function prefabSourceDocument(asset: AssetRow, data: { content: string, hash: string }): PrefabSourceDocument {
    let records: unknown;
    try { records = JSON.parse(data.content); } catch { invalid('Prefab source is not serialized JSON.'); }
    if (!Array.isArray(records) || !records.length || records.some(record => !record || typeof record !== 'object' || Array.isArray(record)) || records[0].__type__ !== 'cc.Prefab') throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Selective removal requires an authoritative serialized cc.Prefab source.' });
    return { asset, ...data, records: records as PrefabRecord[] };
}
function prefabRecord(records: PrefabRecord[], value: unknown): PrefabRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const index = objectField(value, '__id__');
    return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? records[index] : value as PrefabRecord;
}
function sourceComponent(records: PrefabRecord[], fileID: string): PrefabComponent {
    const matches = records.map((component, index) => ({ component, index })).filter(({ component }) => prefabRecord(records, component.__prefab)?.fileId === fileID);
    if (matches.length !== 1) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component fileID is foreign, stale, or ambiguous in its prefab source; no mutation was dispatched.' });
    const match = matches[0], owner = prefabRecord(records, match.component.node);
    if (owner?.__type__ !== 'cc.Node' || !prefabArray(owner._components).some(entry => objectField(entry, '__id__') === match.index)) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed entry does not identify a component owned by a prefab node; no mutation was dispatched.' });
    return { ...match, owner };
}
/** Expands serialized references with stable identities; unreachable deleted records and index renumbering are immaterial. */
function prefabSourceState(records: PrefabRecord[], omittedComponent?: number): unknown {
    const seen = new Map<number, string>();
    const visit = (value: unknown, location: string): unknown => {
        if (!value || typeof value !== 'object') return value;
        const index = objectField(value, '__id__');
        if (typeof index === 'number' && Number.isInteger(index)) {
            const record = records[index];
            if (!record) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Prefab source contains an invalid serialized reference.' });
            if (seen.has(index)) return { $ref: seen.get(index) };
            const info = prefabRecord(records, record.__prefab ?? record._prefab);
            const identity = typeof info?.fileId === 'string' && info.fileId ? `${record.__type__}:${info.fileId}` : location;
            seen.set(index, identity);
            return { $identity: identity, fields: visit(record, identity) };
        }
        if (Array.isArray(value)) return value.map((entry, position) => visit(entry, `${location}.${position}`));
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            let field = objectField(value, key);
            if (key === '_components' && Array.isArray(field)) field = field.filter(entry => objectField(entry, '__id__') !== omittedComponent);
            result[key] = visit(field, `${location}.${key}`);
        }
        return result;
    };
    return visit({ __id__: 0 }, 'prefab');
}
async function resolveRemovedSource(initial: PrefabSourceDocument, selection: RemovedSelection): Promise<{ chain: PrefabSourceDocument[], component: PrefabComponent }> {
    const chain = [initial];
    if (selection.localID.length > 16) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component nested path exceeds the supported depth.' });
    for (const scope of selection.localID.slice(0, -1)) {
        const current = chain[chain.length - 1], records = current.records;
        const instances = records.filter(record => record.__type__ === 'cc.PrefabInstance' && record.fileId === scope);
        const roots = records.filter(record => record.__type__ === 'cc.Node' && instances.some(instance => instance === prefabRecord(records, prefabRecord(records, record._prefab)?.instance)));
        if (roots.length !== 1) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component nested scope does not resolve uniquely in its source.' });
        const nestedID = objectField(prefabRecord(records, roots[0]._prefab)?.asset, '__uuid__');
        if (typeof nestedID !== 'string' || chain.some(item => baseUuid(item.asset.uuid) === baseUuid(nestedID))) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component nested source is invalid or cyclic.' });
        const asset = await resolveAsset({ id: nestedID });
        assertPrefabAsset(asset, 'selective removed component');
        chain.push(prefabSourceDocument(asset, await readAsset(asset)));
    }
    return { chain, component: sourceComponent(chain[chain.length - 1].records, selection.localID[selection.localID.length - 1]) };
}
async function prefabSubtreeState(reference: IInstanceReference): Promise<Map<string, unknown>> {
    const tree = await sceneTree(), located = findSceneNode(tree, reference.id);
    if (!located.node || located.limitReached) throw new ToolError({ code: 'PREFAB_INSPECTION_LIMIT', status: 422, message: 'Cannot resolve the complete selected prefab subtree before mutation.' });
    const pending = [{ node: located.node as unknown, depth: 0 }], nodes = new Map<string, unknown>();
    while (pending.length) {
        const { node, depth } = pending.pop()!;
        const uuid = nodeIdentity(node);
        if (nodes.size >= MAX_ITEMS || depth > 16 || !uuid || nodes.has(uuid)) throw new ToolError({ code: 'PREFAB_INSPECTION_LIMIT', status: 422, message: 'Selected prefab subtree is oversized or has ambiguous identities.' });
        const dump = await Editor.Message.request('scene', 'query-node', uuid) as unknown;
        assertNodeIdentity(uuid, dump, 'selective inspection');
        nodes.set(uuid, dump);
        for (const child of prefabArray(objectField(node, 'children'))) pending.push({ node: child, depth: depth + 1 });
    }
    return nodes;
}
function unrelatedPrefabNodeState(node: unknown, selection: RemovedSelection, restoredUUID?: string, omitOpaqueRemoval = false): unknown {
    const normalize = (value: unknown, key = ''): unknown => {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            let skippedOpaque = false;
            const filtered = key === 'removedComponents' ? value.filter(entry => {
                if (propertyValue(objectField(entry, 'fileID')) === selection.fileID || equalPrefabValue(removedPath(entry), selection.localID)) return false;
                // Stock3.7 Inspector deliberately hides TargetInfo.localID as {}. Omit exactly one opaque record, never all.
                if (omitOpaqueRemoval && !skippedOpaque && equalPrefabValue(propertyValue(entry), {})) { skippedOpaque = true; return false; }
                return true;
            }) : key === '__comps__' && restoredUUID ? value.filter(entry => nodeIdentity(propertyValue(entry)) !== restoredUUID) : value;
            return filtered.map(entry => normalize(entry));
        }
        const result: Record<string, unknown> = {};
        for (const name of Object.keys(value)) result[name] = name === 'value' ? normalize(objectField(value, name), key) : normalize(objectField(value, name), name);
        return result;
    };
    return normalize(node);
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

    private async prefabRemovedComponentOperation(operation: 'removed_component_apply' | 'removed_component_revert', reference: IInstanceReference, fileID: string | undefined, expectedSourceSha256: string | undefined, maxBytes: number): Promise<Record<string, unknown>> {
        if (typeof fileID !== 'string' || !fileID.trim() || fileID.length > 512) invalid('Selective removed component operations require the exact inspected fileID (1–512 characters).');
        const apply = operation === 'removed_component_apply';
        if (apply && (!expectedSourceSha256 || !/^[a-f0-9]{64}$/.test(expectedSourceSha256))) invalid('removed_component_apply requires expectedSourceSha256 from inspection of the source being changed.');
        let dispatched = false;
        let nativeError: string | null = null;
        try {
            const initialNode = await Editor.Message.request('scene', 'query-node', reference.id) as unknown;
            assertNodeIdentity(reference.id, initialNode, 'selective inspection');
            const selection = selectRemovedComponent(initialNode, fileID);
            const rawInspection = await inspectRemovedComponent(reference.id, fileID);
            if (!rawInspection.selected) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Selected removed component is stale; no mutation was dispatched.' });
            selection.localID = rawInspection.selected.localID;
            const subtreeReference = { id: rawInspection.instanceRootUUID, type: 'cc.Node' };
            const before = await prefabSubtreeState(subtreeReference);
            const beforeNode = before.get(reference.id);
            if (!equalPrefabValue(initialNode, beforeNode)) throw new ToolError({ code: 'PREFAB_INSTANCE_CONFLICT', status: 409, message: 'Selected node changed during raw inspection; no mutation was dispatched.' });
            const assetId = rawInspection.rootSourceAssetUUID;
            const asset = await resolveAsset({ id: assetId });
            assertPrefabAsset(asset, operation);
            const resolved = await resolveRemovedSource(prefabSourceDocument(asset, await readAsset(asset)), selection);
            const source = resolved.chain[resolved.chain.length - 1];
            if (apply && source.hash !== expectedSourceSha256) throw new ToolError({ code: 'PREFAB_SOURCE_CONFLICT', status: 409, message: 'Selected removal source changed since inspection; no apply was dispatched.', recovery: 'Inspect the selected component and its exact nested source hash again.' });
            const ownerFileID = prefabRecord(source.records, resolved.component.owner._prefab)?.fileId;
            const nodePrefab = propertyValue(objectField(beforeNode, '__prefab__') ?? objectField(beforeNode, '_prefab') ?? objectField(beforeNode, 'prefab'));
            const nodeFileID = propertyValue(objectField(nodePrefab, 'fileId') ?? objectField(nodePrefab, 'fileID'));
            if (typeof ownerFileID !== 'string' || !ownerFileID || ownerFileID !== rawInspection.selected.ownerFileID || resolved.component.component.__type__ !== rawInspection.selected.componentType || baseUuid(source.asset.uuid) !== baseUuid(rawInspection.selected.sourceAssetUUID) || (nodeFileID !== undefined && nodeFileID !== ownerFileID)) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Removed component source owner/type does not match authoritative raw inspection; no mutation was dispatched.' });
            const expectedSourceState = prefabSourceState(source.records, apply ? resolved.component.index : undefined);
            const beforeComponents = prefabArray(objectField(beforeNode, '__comps__'));
            const componentIDs = beforeComponents.map(component => nodeIdentity(propertyValue(component)));
            if (componentIDs.some(id => !id) || new Set(componentIDs).size !== componentIDs.length) throw new ToolError({ code: 'INVALID_REMOVED_COMPONENT', status: 422, message: 'Existing component identities cannot be inspected unambiguously.' });
            for (const document of resolved.chain) {
                if ((await readAsset(document.asset)).hash !== document.hash) throw new ToolError({ code: 'PREFAB_SOURCE_CONFLICT', status: 409, message: 'Prefab source changed during preflight; no mutation was dispatched.' });
            }
            const freshNode = await Editor.Message.request('scene', 'query-node', selection.nodeUUID) as unknown;
            if (!equalPrefabValue(beforeNode, freshNode)) throw new ToolError({ code: 'PREFAB_INSTANCE_CONFLICT', status: 409, message: 'Prefab instance changed during preflight; no mutation was dispatched.' });
            if (!equalPrefabValue(rawInspection, await inspectRemovedComponent(reference.id, fileID))) throw new ToolError({ code: 'PREFAB_INSTANCE_CONFLICT', status: 409, message: 'Raw removed component state changed during preflight; no mutation was dispatched.' });
            const nativeRequest = apply ? 'apply-removed-component' : 'revert-removed-component';
            let nativeResult: unknown;
            dispatched = true;
            try {
                // Matching Creator3.7 facade declares positional (nodeUUID, fileID), returning void.
                nativeResult = await Editor.Message.request('scene', nativeRequest, selection.nodeUUID, selection.fileID);
            } catch (error) { nativeError = (error instanceof Error ? error.message : String(error)).slice(0, 512); }
            const after = await prefabSubtreeState(subtreeReference);
            const rawAfter = await inspectRemovedComponent(reference.id, fileID);
            const rawStateVerified = rawAfter.selected === null && rawAfter.instanceRootUUID === rawInspection.instanceRootUUID && rawAfter.rootSourceAssetUUID === rawInspection.rootSourceAssetUUID && equalPrefabValue(rawInspection.removedComponents.filter(ids => !equalPrefabValue(ids, selection.localID)), rawAfter.removedComponents);
            const afterNode = after.get(reference.id);
            const afterDocuments: PrefabSourceDocument[] = [];
            for (const document of resolved.chain) afterDocuments.push(prefabSourceDocument(document.asset, await readAsset(document.asset)));
            const sourceAfter = afterDocuments[afterDocuments.length - 1];
            const unchangedAncestors = resolved.chain.slice(0, -1).every((document, index) => document.hash === afterDocuments[index].hash);
            const sourceVerified = apply
                ? source.hash !== sourceAfter.hash && equalPrefabValue(expectedSourceState, prefabSourceState(sourceAfter.records))
                : source.hash === sourceAfter.hash;
            const remainingRemoved = prefabArray(objectField(afterNode, 'removedComponents'));
            const selectedRemovalCleared = !remainingRemoved.some(entry => propertyValue(objectField(entry, 'fileID')) === fileID);
            const rawRemaining = prefabArray(prefabInstanceData(afterNode)?.removedComponents);
            const rawBefore = prefabArray(prefabInstanceData(beforeNode)?.removedComponents);
            const rawRemovalCleared = rawBefore.length === 0 || (rawRemaining.length === rawBefore.length - 1 && !rawRemaining.some(entry => equalPrefabValue(removedPath(entry), selection.localID)));
            const afterComponents = prefabArray(objectField(afterNode, '__comps__'));
            const added = afterComponents.filter(component => !componentIDs.includes(nodeIdentity(propertyValue(component))));
            const restored = !apply && added.length === 1 ? nodeIdentity(propertyValue(added[0])) : undefined;
            const restoredType = added.length === 1 ? componentType(added[0]) : undefined;
            const restoredValue = added.length === 1 ? propertyValue(added[0]) : undefined;
            const restoredPrefab = propertyValue(objectField(restoredValue, '__prefab') ?? objectField(restoredValue, '__prefab__'));
            const restoredFileID = propertyValue(objectField(restoredPrefab, 'fileId') ?? objectField(restoredPrefab, 'fileID'));
            const componentsVerified = apply ? equalPrefabValue(beforeComponents, afterComponents)
                : !!restored && restoredType === resolved.component.component.__type__ && (restoredFileID === undefined || restoredFileID === selection.fileID);
            const nodeIDsPreserved = before.size === after.size && [...before.keys()].every(id => after.has(id));
            const unrelatedPreserved = nodeIDsPreserved && [...before].every(([id, dump]) => {
                if (id !== reference.id && id !== rawInspection.instanceRootUUID) return equalPrefabValue(dump, after.get(id));
                const rawCountBefore = prefabArray(prefabInstanceData(dump)?.removedComponents).length;
                const rawCountAfter = prefabArray(prefabInstanceData(after.get(id))?.removedComponents).length;
                const opaque = rawCountBefore === rawCountAfter + 1 && prefabArray(prefabInstanceData(dump)?.removedComponents).some(entry => equalPrefabValue(entry, {}));
                return equalPrefabValue(unrelatedPrefabNodeState(dump, selection, undefined, opaque), unrelatedPrefabNodeState(after.get(id), selection, id === reference.id ? restored : undefined));
            });
            const postconditions = { selectedRemovalCleared: selectedRemovalCleared && rawRemovalCleared && rawStateVerified, selectedComponentVerified: componentsVerified, sourceVerified, unrelatedOverridesPreserved: unrelatedPreserved, nestedIdentitiesPreserved: nodeIDsPreserved && unchangedAncestors };
            if (!Object.values(postconditions).every(Boolean)) throw new ToolError({ code: 'PREFAB_REMOVED_COMPONENT_UNVERIFIED', status: 502, message: 'Native removal operation was dispatched but its complete selective postcondition could not be verified.', details: { postconditions, nativeError, mutationDispatched: true, outcome: 'unknown', rollbackStatus: 'unknown', sceneSaved: false }, recovery: 'Inspect the instance and all affected prefab source hashes. Do not retry or restore the full instance automatically.' });
            const changes = apply ? [{ path: 'components', identity: selection.localID.join('/'), before: { fileID: selection.fileID, type: resolved.component.component.__type__ }, after: null }] : [];
            return boundPrefabResponse({ reference, operation, persisted: apply, outcome: 'verified', mutationDispatched: true, rollbackStatus: 'not-needed', sceneSaved: false, changedIdentities: [{ nodeUUID: selection.nodeUUID, fileID: selection.fileID, localID: selection.localID, restoredComponentUUID: restored ?? null }], postconditions, readBack: afterNode, sourceReadBack: { id: source.asset.uuid, url: source.asset.url, beforeSha256: source.hash, afterSha256: sourceAfter.hash, ancestors: resolved.chain.slice(0, -1).map(document => ({ id: document.asset.uuid, sha256: document.hash })) }, sourceChanges: changes, sourceDiffTruncated: false, nativeResult: nativeResult === false ? false : nativeResult === true ? true : null, nativeError }, maxBytes);
        } catch (error) {
            if (!dispatched && error instanceof ToolError) throw error;
            if (dispatched && error instanceof ToolError && error.code === 'PREFAB_REMOVED_COMPONENT_UNVERIFIED') throw error;
            throw new ToolError({ code: dispatched ? 'PREFAB_REMOVED_COMPONENT_UNVERIFIED' : 'PREFAB_REMOVED_COMPONENT_PREFLIGHT_FAILED', status: 502, message: dispatched ? 'Selective native mutation was dispatched, but read-back failed; its outcome is unknown.' : 'Selective removed component preflight failed before dispatch.', details: { cause: (error instanceof Error ? error.message : String(error)).slice(0, 512), mutationDispatched: dispatched, outcome: dispatched ? 'unknown' : 'refused', rollbackStatus: dispatched ? 'unknown' : 'not-needed', sceneSaved: false }, recovery: dispatched ? 'Inspect the instance and source before any retry; no automatic rollback or retry was attempted.' : 'Inspect the authoritative removed component descriptor and source.' });
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

    @utcpTool('prefabApplyOverrides', 'Apply all linked-instance overrides (default), or one inspected removed component using removed_component_apply plus exact fileID and mandatory expectedSourceSha256. Native return is not proof: selective source diff and unrelated/nested identity read-back are verified. Does not save the scene; never retry an ambiguous mutation.', { type: 'object', additionalProperties: false, properties: { reference: InstanceReferenceSchema, operation: { type: 'string', enum: ['apply', 'removed_component_apply'] }, fileID: { type: 'string', minLength: 1, maxLength: 512 }, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144, default: 32768 }, expectedSourceSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' }, sourceChanges: { type: 'array' }, sourceDiffTruncated: { type: 'boolean' }, responseTruncated: { type: 'boolean' }, readBackTruncated: { type: 'boolean' }, sceneSaved: { type: 'boolean' }, outcome: { type: 'string' }, mutationDispatched: { type: 'boolean' }, rollbackStatus: { type: 'string' }, changedIdentities: { type: 'array' }, postconditions: { type: 'object' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack', 'sourceChanges', 'sourceDiffTruncated', 'sceneSaved'] }, 'POST', ['prefab', 'apply', 'overrides'])
    async prefabApplyOverrides(args: { reference: IInstanceReference, operation?: 'apply' | 'removed_component_apply', fileID?: string, expectedSourceSha256?: string, maxBytes?: number }): Promise<Record<string, unknown>> {
        const maxBytes = prefabResponseLimit(args.maxBytes);
        if (args.operation === 'removed_component_apply') return this.prefabRemovedComponentOperation(args.operation, args.reference, args.fileID, args.expectedSourceSha256, maxBytes);
        if (args.operation !== undefined && args.operation !== 'apply') invalid('Unsupported prefab apply operation.');
        if (args.fileID !== undefined) invalid('fileID is only accepted for removed_component_apply; full apply remains distinct.');
        return this.prefabSceneOperation('apply', args.reference, args.expectedSourceSha256, maxBytes);
    }
    @utcpTool('prefabRevertOverrides', 'Revert the full linked instance (default), or restore one inspected removed component using removed_component_revert and exact fileID. Paths remain unsupported. Selective revert verifies component restoration, unchanged source and unrelated/nested identity; does not save the scene or retry ambiguous mutations.', { type: 'object', properties: { reference: InstanceReferenceSchema, operation: { type: 'string', enum: ['revert', 'removed_component_revert'] }, fileID: { type: 'string', minLength: 1, maxLength: 512 }, paths: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string' } }, maxBytes: { type: 'integer', minimum: 2048, maximum: 262144, default: 32768 } }, required: ['reference'] }, { type: 'object', properties: { reference: { type: 'object' }, operation: { type: 'string' }, persisted: { type: 'boolean' }, readBack: { type: 'object' }, sourceReadBack: { type: 'object' }, sceneSaved: { type: 'boolean' }, outcome: { type: 'string' }, mutationDispatched: { type: 'boolean' }, rollbackStatus: { type: 'string' }, changedIdentities: { type: 'array' }, postconditions: { type: 'object' }, sourceChanges: { type: 'array' }, sourceDiffTruncated: { type: 'boolean' }, responseTruncated: { type: 'boolean' }, readBackTruncated: { type: 'boolean' } }, required: ['reference', 'operation', 'persisted', 'readBack', 'sourceReadBack'] }, 'POST', ['prefab', 'revert', 'overrides'])
    async prefabRevertOverrides(args: { reference: IInstanceReference, operation?: 'revert' | 'removed_component_revert', fileID?: string, paths?: string[], maxBytes?: number }): Promise<Record<string, unknown>> {
        if (args.paths && args.paths.length > 0) throw new ToolError({ code: 'UNSUPPORTED_SELECTIVE_REVERT', status: 422, message: 'Creator 3.7.3 restore-prefab reverts the full instance and does not expose selective path restoration.' });
        const maxBytes = prefabResponseLimit(args.maxBytes);
        if (args.operation === 'removed_component_revert') return this.prefabRemovedComponentOperation(args.operation, args.reference, args.fileID, undefined, maxBytes);
        if (args.operation !== undefined && args.operation !== 'revert') invalid('Unsupported prefab revert operation.');
        if (args.fileID !== undefined) invalid('fileID is only accepted for removed_component_revert; full revert remains distinct.');
        return this.prefabSceneOperation('revert', args.reference, undefined, maxBytes);
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
        const operations: AssetImportSettingsSetResult[] = [];
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
    async previewResolutionSet(args: { width: number, height: number }): Promise<Record<string, unknown>> {
        requireCreator38('previewResolutionSet');
        try {
            const result = await Editor.Message.request('preview', 'set-resolution', { width: args.width, height: args.height });
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Creator preview resolution IPC returned no typed read-back.' });
            const response = result as Record<string, unknown>;
            if (response.width !== args.width || response.height !== args.height) throw new ToolError({ code: 'READBACK_MISMATCH', status: 502, message: 'Creator preview resolution read-back did not match the requested dimensions.', details: { requested: args, readBack: response } });
            return { width: args.width, height: args.height, persisted: true, supported: true, readBack: response };
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'UNSUPPORTED_PREVIEW_IPC', status: 422, message: 'Creator preview resolution IPC is unavailable.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }

    @utcpTool('editorUndoTransactionProbe', 'Probe snapshot, undo, redo, and snapshot-abort lifecycle boundaries without leaving a pending transaction.', { type: 'object', properties: {} }, { type: 'object', properties: { supported: { type: 'boolean' }, boundaries: { type: 'array' }, clean: { type: 'boolean' } }, required: ['supported', 'boundaries', 'clean'] }, 'POST', ['editor', 'undo', 'transaction', 'probe'])
    async editorUndoTransactionProbe(): Promise<Record<string, unknown>> { const boundaries: string[] = []; try { await Editor.Message.request('scene', 'snapshot'); boundaries.push('snapshot'); await Editor.Message.request('scene', 'snapshot-abort'); boundaries.push('snapshot-abort'); return { supported: true, boundaries, clean: true }; } catch (error) { throw new ToolError({ code: 'UNDO_PROBE_FAILED', status: 422, message: 'Creator undo transaction lifecycle is unavailable.', details: { cause: error instanceof Error ? error.message : String(error) } }); } }

    @utcpTool('broadcastObserve', 'Observe one allowlisted Creator broadcast through a byte-bounded register, observe, and dispose lifecycle.', { type: 'object', additionalProperties: false, properties: { topic: { type: 'string', enum: ['ccp3x:probe', 'scene:change', 'asset-db:change'] } }, required: ['topic'] }, { type: 'object', properties: { topic: { type: 'string' }, supported: { type: 'boolean' }, observed: { type: 'boolean' }, lifecycle: { type: 'array' }, eventBytes: { type: 'integer' }, truncated: { type: 'boolean' } }, required: ['topic', 'supported', 'observed', 'lifecycle', 'eventBytes', 'truncated'] }, 'GET', ['broadcast', 'event', 'observe'])
    async broadcastObserve(args: { topic: string }): Promise<Record<string, unknown>> {
        if (!['ccp3x:probe', 'scene:change', 'asset-db:change'].includes(args?.topic)) invalid('Broadcast topic is not allowlisted.');
        if (broadcastListeners.size >= MAX_ITEMS) throw new ToolError({ code: 'LISTENER_LIMIT_EXCEEDED', status: 429, message: 'Owned broadcast listener limit reached; inspect retained listeners before retrying.' });
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
        broadcastListeners.set(handler, { topic: args.topic, state: 'registered' });
        try {
            if (args.topic === 'ccp3x:probe') messages.broadcast(args.topic, marker);
            await new Promise((resolve) => setTimeout(resolve, 50));
            if (observed !== null) lifecycle.push('observed');
        } finally {
            try {
                messages.removeBroadcastListener(args.topic, handler);
                broadcastListeners.delete(handler);
            } catch (error) {
                broadcastListeners.set(handler, { topic: args.topic, state: 'removal-failed' });
                throw error;
            }
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
        return { supported: true, listeners: Array.from(broadcastListeners.values(), listener => ({ ...listener })), limitation: 'Only main-process broadcastObserve listeners owned by this module are tracked; panel and arbitrary Creator listeners are not enumerated. Removal failures remain listed until module teardown.' };
    }
}
