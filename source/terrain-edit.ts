import fs from 'fs-extra';
import { createHash } from 'crypto';

export interface TerrainCell { i: number; j: number; height: number }
export interface TerrainEditRequest { nodeUuid: string; componentUuid: string; assetUuid: string; cells: TerrainCell[] }
interface TerrainAsset { _uuid: string; heights: Uint16Array }
export interface TerrainNode { uuid: string; getComponents(type: unknown): TerrainComponent[] }
export interface TerrainComponent {
    uuid: string; node: TerrainNode; constructor: unknown; _asset: TerrainAsset | null;
    vertexCount: number[]; heights: Uint16Array; isTerrainChange: boolean;
    getHeight(i: number, j: number): number; setHeight(i: number, j: number, height: number): void;
}
export interface TerrainEngine {
    GAME_VIEW?: boolean; js?: { getClassByName(name: string): unknown };
    assetManager?: { loadAny(request: { uuid: string }, options: { reloadAsset: boolean }, callback: (error: Error | null, asset?: TerrainAsset) => void): void };
}
export interface TerrainPersistence {
    manager: { serialize(component: TerrainComponent): Uint8Array; saveAsset(isClose: boolean, component: TerrainComponent): Promise<number> };
    saveSource(assetUuid: string, bytes: Buffer): Promise<unknown>;
    queryMode(): string;
}
export interface TerrainEditResult {
    success: boolean; changed: boolean; verified: boolean; mutationStarted: boolean;
    nodeUuid: string; componentUuid: string; assetUuid: string;
    restoration: 'not-needed' | 'confirmed' | 'failed';
    previous?: TerrainCell[]; readBack?: TerrainCell[]; sourceBeforeSha256?: string; sourceAfterSha256?: string;
    sourceBytes?: number; reimported?: boolean; reloaded?: boolean; writer?: 'Creator.TerrainManager.saveAsset';
    error?: { code: string; message: string; restorationCause?: string };
}
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_VERTICES = 262144;
const activeAssets = new Set<string>();
class TerrainFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
function demand(value: unknown, code: string, message: string): asserts value { if (!value) throw new TerrainFailure(code, message); }
function hash(bytes: Buffer | Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

export function validateTerrainEditRequest(request: TerrainEditRequest): void {
    demand(request && [request.nodeUuid, request.componentUuid, request.assetUuid].every(id => typeof id === 'string' && id.length > 0 && id.length <= 256), 'INVALID_ARGUMENT', 'Exact node, Terrain component, and TerrainAsset UUIDs are required.');
    demand(Array.isArray(request.cells) && request.cells.length > 0 && request.cells.length <= 256, 'INVALID_ARGUMENT', 'cells must contain from 1 to 256 height edits.');
    const seen = new Set<string>();
    for (const cell of request.cells) {
        demand(cell && Number.isInteger(cell.i) && Number.isInteger(cell.j) && cell.i >= 0 && cell.j >= 0 && typeof cell.height === 'number' && Number.isFinite(cell.height) && cell.height >= -256 && cell.height <= 255.9921875, 'INVALID_ARGUMENT', 'Each cell requires non-negative integer i/j and a finite native height from -256 to 255.9921875.');
        const key = `${cell.i}:${cell.j}`;
        demand(!seen.has(key), 'INVALID_ARGUMENT', 'Duplicate terrain cells are not supported.');
        seen.add(key);
    }
}

interface TerrainSource { width: number; height: number; count: number; heightsOffset: number }
/** Read only the authoritative V8 binary geometry header; never synthesize terrain source bytes. */
function sourceGeometry(bytes: Buffer): TerrainSource {
    demand(bytes.length >= 28 && bytes.readUInt32LE(0) === 0x01010008, 'UNSUPPORTED_TERRAIN_SOURCE', 'Persistent editing requires a hydrated native Terrain V8 source (not the empty default preset or a legacy format).');
    const blocksI = bytes.readInt32LE(12), blocksJ = bytes.readInt32LE(16);
    const width = blocksI * 32 + 1, height = blocksJ * 32 + 1, count = bytes.readInt32LE(24);
    demand(blocksI > 0 && blocksJ > 0 && Number.isSafeInteger(width * height) && width * height <= MAX_VERTICES && count === width * height && 28 + count * 2 <= bytes.length, 'INVALID_TERRAIN_SOURCE', 'Native terrain dimensions and height data are malformed or exceed 262144 vertices.');
    demand(Number.isFinite(bytes.readDoubleLE(4)) && bytes.readDoubleLE(4) > 0, 'INVALID_TERRAIN_SOURCE', 'Native terrain tile size is invalid.');
    return { width, height, count, heightsOffset: 28 };
}
async function readSource(file: string): Promise<Buffer> {
    const stat = await fs.stat(file);
    demand(stat.isFile() && stat.size > 0 && stat.size <= MAX_SOURCE_BYTES, 'SOURCE_TOO_LARGE', 'Terrain source must be a file of at most 8 MiB.');
    const bytes = await fs.readFile(file);
    demand(bytes.length <= MAX_SOURCE_BYTES, 'SOURCE_TOO_LARGE', 'Terrain source grew beyond 8 MiB.');
    return bytes;
}
function cellsFromSource(bytes: Buffer, cells: TerrainCell[]): TerrainCell[] {
    const geometry = sourceGeometry(bytes);
    return cells.map(cell => ({ i: cell.i, j: cell.j, height: (bytes.readUInt16LE(geometry.heightsOffset + (cell.j * geometry.width + cell.i) * 2) - 32768) / 128 }));
}
function cellsMatch(actual: TerrainCell[], expected: TerrainCell[]): boolean { return actual.length === expected.length && actual.every((cell, index) => cell.height === expected[index].height); }
async function assetInfo(assetUuid: string): Promise<{ uuid: string; url: string; file: string }> {
    const info = await Editor.Message.request('asset-db', 'query-asset-info', assetUuid) as unknown;
    demand(info && typeof info === 'object' && 'uuid' in info && info.uuid === assetUuid && 'type' in info && info.type === 'cc.TerrainAsset' && 'url' in info && typeof info.url === 'string' && /^db:\/\/assets\/.+\.terrain$/.test(info.url) && !info.url.includes('..') && 'file' in info && typeof info.file === 'string' && info.file.length > 0, 'TYPE_MISMATCH', 'Exact project-local native TerrainAsset source identity is required.');
    return { uuid: info.uuid, url: info.url, file: info.file };
}

export async function executeTerrainEdit(request: TerrainEditRequest, engine: TerrainEngine, findNode: (id: string) => Promise<TerrainNode | null>, persistence: TerrainPersistence): Promise<TerrainEditResult> {
    const result: TerrainEditResult = { success: false, changed: false, verified: false, mutationStarted: false, nodeUuid: request?.nodeUuid, componentUuid: request?.componentUuid, assetUuid: request?.assetUuid, restoration: 'not-needed' };
    let locked = false, original: Buffer | undefined, target: TerrainComponent | undefined, previous: TerrainCell[] = [], file = '', url = '';
    let originalDirty = false;
    try {
        validateTerrainEditRequest(request);
        demand(!activeAssets.has(request.assetUuid), 'TERRAIN_BUSY', 'Another edit of this TerrainAsset is in progress.');
        activeAssets.add(request.assetUuid); locked = true;
        demand(engine.GAME_VIEW !== true && typeof persistence.queryMode === 'function' && ['general', 'prefab'].includes(persistence.queryMode()), 'UNSUPPORTED_CONTEXT', 'Terrain persistence is supported only in the verified edit-scene facade context.');
        const Terrain = engine.js?.getClassByName('cc.Terrain');
        demand(typeof Terrain === 'function' && typeof persistence.manager?.serialize === 'function' && typeof persistence.manager?.saveAsset === 'function' && typeof persistence.saveSource === 'function' && typeof engine.assetManager?.loadAny === 'function', 'UNSUPPORTED_EDITOR_API', 'Native Terrain class, manager serializer/writer, and asset reload owner are required.');
        const node = await findNode(request.nodeUuid);
        demand(node?.uuid === request.nodeUuid && typeof node.getComponents === 'function', 'TARGET_NOT_FOUND', 'Exact terrain node was not found.');
        const components = node.getComponents(Terrain);
        target = components.find(component => component.uuid === request.componentUuid);
        demand(target && target.node === node && target.constructor === Terrain && target._asset?._uuid === request.assetUuid, 'TYPE_MISMATCH', 'Node, native Terrain component, and attached TerrainAsset identities do not match.');
        demand(typeof target.setHeight === 'function' && typeof target.getHeight === 'function' && typeof target.isTerrainChange === 'boolean', 'UNSUPPORTED_EDITOR_API', 'Native height access and editor terrain dirty state are unavailable.');
        originalDirty = target.isTerrainChange;
        demand(!originalDirty, 'TERRAIN_DIRTY', 'Save or discard existing terrain editor changes before persistent height editing.');
        const info = await assetInfo(request.assetUuid); file = info.file; url = info.url;
        original = await readSource(file); const geometry = sourceGeometry(original);
        const vertices = target.vertexCount;
        demand(Array.isArray(vertices) && vertices.length === 2 && vertices[0] === geometry.width && vertices[1] === geometry.height && target.heights instanceof Uint16Array && target.heights.length === geometry.count && target._asset.heights instanceof Uint16Array && target._asset.heights.length === geometry.count, 'TERRAIN_SOURCE_MISMATCH', 'Loaded terrain geometry must exactly match its persisted source.');
        for (let index = 0; index < geometry.count; index++) {
            const height = original.readUInt16LE(geometry.heightsOffset + index * 2);
            demand(target.heights[index] === height && target._asset.heights[index] === height, 'TERRAIN_DIRTY', 'Loaded terrain heights differ from source; refusing to overwrite existing edits.');
        }
        for (const cell of request.cells) demand(cell.i < geometry.width && cell.j < geometry.height, 'OUT_OF_BOUNDS', 'Every terrain cell must fit the native vertex bounds before mutation.');
        previous = cellsFromSource(original, request.cells);
        const expected = request.cells.map(cell => ({ i: cell.i, j: cell.j, height: (Math.trunc(32768 + cell.height * 128) - 32768) / 128 }));
        result.previous = previous; result.sourceBeforeSha256 = hash(original);
        if (cellsMatch(previous, expected)) {
            return { ...result, success: true, verified: true, readBack: previous, sourceAfterSha256: result.sourceBeforeSha256, sourceBytes: original.length, reimported: false, reloaded: false, writer: 'Creator.TerrainManager.saveAsset' };
        }
        const beforeSerialized = persistence.manager.serialize(target);
        demand(beforeSerialized instanceof Uint8Array && beforeSerialized.byteLength <= MAX_SOURCE_BYTES, 'UNSUPPORTED_EDITOR_API', 'Native terrain serializer did not return bounded bytes.');
        sourceGeometry(Buffer.from(beforeSerialized.buffer, beforeSerialized.byteOffset, beforeSerialized.byteLength));
        demand(hash(beforeSerialized) === result.sourceBeforeSha256, 'TERRAIN_DIRTY', 'Native serialized terrain differs from disk; save existing geometry/layer edits first.');
        demand(hash(await readSource(file)) === result.sourceBeforeSha256, 'SOURCE_CHANGED', 'Terrain source changed during preflight.');
        result.mutationStarted = true; result.changed = true;
        for (const cell of request.cells) target.setHeight(cell.i, cell.j, cell.height);
        demand(cellsMatch(request.cells.map(cell => ({ ...cell, height: target!.getHeight(cell.i, cell.j) })), expected), 'READBACK_MISMATCH', 'Native setter did not retain the requested quantized heights.');
        target.isTerrainChange = true;
        const serialized = persistence.manager.serialize(target);
        demand(serialized instanceof Uint8Array && serialized.byteLength <= MAX_SOURCE_BYTES, 'SOURCE_TOO_LARGE', 'Native terrain serializer exceeds the source bound.');
        const expectedSourceHash = hash(serialized);
        const saveResult = await persistence.manager.saveAsset(false, target);
        demand(saveResult === 0 && !target.isTerrainChange, 'TERRAIN_WRITE_FAILED', 'Native TerrainManager source writer refused the save.');
        const disk = await readSource(file);
        demand(hash(disk) === expectedSourceHash && cellsMatch(cellsFromSource(disk, request.cells), expected), 'READBACK_MISMATCH', 'Saved disk source differs from the native serializer or requested heights.');
        await Editor.Message.request('asset-db', 'reimport-asset', request.assetUuid);
        await reloadTerrain(target, request, engine);
        const afterInfo = await assetInfo(request.assetUuid);
        demand(afterInfo.file === file && afterInfo.url === url && hash(await readSource(file)) === expectedSourceHash && cellsMatch(request.cells.map(cell => ({ ...cell, height: target!.getHeight(cell.i, cell.j) })), expected), 'READBACK_MISMATCH', 'Terrain identity or persisted heights changed after native reimport/reload.');
        return { ...result, success: true, changed: true, verified: true, readBack: expected, sourceAfterSha256: expectedSourceHash, sourceBytes: disk.length, reimported: true, reloaded: true, writer: 'Creator.TerrainManager.saveAsset' };
    } catch (error: unknown) {
        result.error = { code: error instanceof TerrainFailure ? error.code : 'TERRAIN_OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) };
        if (result.mutationStarted && original && target) {
            try {
                const currentInfo = await assetInfo(request.assetUuid);
                demand(currentInfo.file === file && currentInfo.url === url, 'RESTORATION_FAILED', 'Terrain source identity changed; restoration refused.');
                for (const cell of previous) target.setHeight(cell.i, cell.j, cell.height);
                let sourceNeedsRestore = true;
                try { sourceNeedsRestore = hash(await readSource(file)) !== hash(original); } catch { /* A missing/partial source also requires the native backup writer. */ }
                if (sourceNeedsRestore) demand(await persistence.saveSource(request.assetUuid, original), 'RESTORATION_FAILED', 'Native asset-db writer refused source restoration.');
                await Editor.Message.request('asset-db', 'reimport-asset', request.assetUuid);
                await reloadTerrain(target, request, engine);
                target.isTerrainChange = originalDirty;
                demand(hash(await readSource(file)) === hash(original) && cellsMatch(previous.map(cell => ({ ...cell, height: target!.getHeight(cell.i, cell.j) })), previous), 'RESTORATION_FAILED', 'Original terrain source or loaded heights were not restored.');
                result.restoration = 'confirmed'; result.changed = false;
            } catch (restoreError: unknown) { result.restoration = 'failed'; result.error.restorationCause = restoreError instanceof Error ? restoreError.message : String(restoreError); }
        }
        return result;
    } finally { if (locked) activeAssets.delete(request.assetUuid); }
}

async function reloadTerrain(target: TerrainComponent, request: TerrainEditRequest, engine: TerrainEngine): Promise<void> {
    const asset = await new Promise<TerrainAsset>((resolve, reject) => engine.assetManager!.loadAny({ uuid: request.assetUuid }, { reloadAsset: true }, (error, loaded) => {
        if (error) reject(error); else if (!loaded || loaded._uuid !== request.assetUuid) reject(new TerrainFailure('READBACK_MISMATCH', 'Reload returned a different TerrainAsset.')); else resolve(loaded);
    }));
    demand(target.uuid === request.componentUuid && target.node.uuid === request.nodeUuid && target._asset?._uuid === request.assetUuid && asset !== target._asset, 'READBACK_MISMATCH', 'Reload must produce a fresh asset for the unchanged terrain identity.');
    // Creator's serialized Terrain asset setter rebuilds geometry from the freshly imported native asset.
    target._asset = asset;
    demand(target._asset === asset, 'READBACK_MISMATCH', 'Terrain did not attach the reimported native asset.');
}
