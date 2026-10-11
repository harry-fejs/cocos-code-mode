import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { IInstanceReference, InstanceReferenceSchema } from '../schemas';
import { ToolError } from '../tool-error';
import { AdvancedCapabilityTools } from './advanced-capability-tools';

type AssetInfoLike = {
    uuid?: string;
    url?: string;
    type?: string;
    importer?: string;
    file?: string;
    invalid?: boolean;
    imported?: boolean;
};

type TilemapLayer = { id?: number; name: string; data: number[] };
type TilesetImage = { assetPath?: string; reference?: IInstanceReference };
type TilemapTileset = { name?: string; image: TilesetImage; firstGid: number; tileCount: number; columns: number };
type TilemapCreateArgs = {
    write: true;
    assetPath: string;
    width: number;
    height: number;
    tileWidth: number;
    tileHeight: number;
    layers: TilemapLayer[];
    tilesets: TilemapTileset[];
};
type ResolvedImage = { url: string; file: string; source: string; reference: IInstanceReference };
type PreparedTilemap = { args: TilemapCreateArgs; targetUrl: string; targetFile: string; xml: string; images: ResolvedImage[] };

const MAX_DIMENSION = 4096;
const MAX_CELLS = 1_000_000;
const MAX_LAYERS = 128;
const MAX_TILESETS = 32;
const MAX_PATH = 512;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

function fail(code: string, message: string, status = 400, details?: Record<string, unknown>): never {
    throw new ToolError({ code, message, status, details });
}
function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, label: string, max = 256): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_ARGUMENT', `${label} must be a bounded non-empty string.`);
    return value;
}
function integer(value: unknown, label: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail('INVALID_ARGUMENT', `${label} must be an integer from ${min} to ${max}.`);
    return value;
}
function escapeXml(value: unknown): string {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function projectPath(): string {
    const project = (Editor.Project as { path?: unknown } | undefined)?.path;
    if (typeof project !== 'string' || !project) fail('PROJECT_UNAVAILABLE', 'An open Creator project is required.', 503);
    return path.resolve(project);
}
function normalizeAssetUrl(input: unknown): string {
    const value = text(input, 'assetPath', MAX_PATH).replace(/\\/g, '/');
    if (!/^db:\/\/assets\/[A-Za-z0-9._/-]+\.tmx$/i.test(value)) fail('INVALID_ARGUMENT', 'assetPath must be a new db://assets/*.tmx path without traversal.');
    const segments = value.slice('db://assets/'.length).split('/');
    if (segments.some((segment) => !segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment))) fail('INVALID_ARGUMENT', 'assetPath contains an invalid path segment.');
    return value;
}
function targetFileForUrl(url: string): string {
    const root = projectPath();
    const file = path.resolve(root, 'assets', url.slice('db://assets/'.length));
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.toLowerCase().startsWith(`assets${path.sep}`)) fail('INVALID_ARGUMENT', 'assetPath escapes the project assets boundary.');
    return file;
}
function assertNewPath(url: string, file: string): void {
    const parent = path.dirname(file);
    try {
        const parentReal = fs.realpathSync(parent);
        if (path.resolve(parentReal) !== path.resolve(parent)) fail('INVALID_ARGUMENT', 'Tilemap destination parent must not be a symlink.');
        if (!fs.statSync(parentReal).isDirectory()) fail('TARGET_NOT_FOUND', 'Tilemap destination parent directory does not exist.', 404);
    } catch (error) {
        if (error instanceof ToolError) throw error;
        fail('TARGET_NOT_FOUND', 'Tilemap destination parent directory does not exist.', 404);
    }
    for (const candidate of [file, `${file}.meta`]) {
        try {
            fs.lstatSync(candidate);
            fail('TILEMAP_SOURCE_CONFLICT', 'Tilemap creation refuses an existing source or metadata path.', 409, { assetPath: url });
        } catch (error) {
            if (error instanceof ToolError) throw error;
            if (record(error)?.code !== 'ENOENT') fail('TILEMAP_SOURCE_ACCESS_FAILED', 'Cannot confirm the requested tilemap source path is unused.', 502, { assetPath: url });
        }
    }
}
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function assetLooksLikeImage(info: AssetInfoLike): boolean {
    return info.type === 'cc.ImageAsset' || info.type === 'cc.Texture2D' || info.importer === 'image' || info.importer === 'texture' || /\.(?:png|jpg|jpeg|webp|bmp|gif)$/i.test(info.url ?? '');
}
async function queryAsset(identifier: string): Promise<AssetInfoLike | null> {
    try { return await Editor.Message.request('asset-db', 'query-asset-info', identifier) as AssetInfoLike | null; }
    catch (error) { fail('ASSET_QUERY_FAILED', 'Creator asset database query failed; tilemap resource identity is unconfirmed.', 502, { cause: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256) }); }
}
async function resolveImage(image: TilesetImage, destinationFile: string): Promise<ResolvedImage> {
    const identifier = image.reference?.id ?? image.assetPath;
    if (!identifier) fail('INVALID_ARGUMENT', 'Each tileset image requires an existing assetPath or reference.');
    if (image.assetPath !== undefined && !/^db:\/\/assets\/[A-Za-z0-9._/-]+$/i.test(image.assetPath)) fail('INVALID_ARGUMENT', 'Tileset image assetPath must be an explicit db://assets resource path.');
    const info = await queryAsset(identifier);
    if (!info?.uuid || !info.url || !assetLooksLikeImage(info)) fail('TILESET_RESOURCE_INVALID', 'Tileset image must resolve to an existing imported image asset.', 422, { identifier });
    const file = info.file ?? await Editor.Message.request('asset-db', 'query-path', info.uuid).catch(() => null) as string | null;
    if (typeof file !== 'string' || !file) fail('TILESET_RESOURCE_UNAVAILABLE', 'Tileset image has no readable source path.', 422, { identifier });
    let imageFile: string;
    try {
        imageFile = fs.realpathSync(file);
        const root = fs.realpathSync(projectPath());
        const relativeToProject = path.relative(root, imageFile);
        if (!relativeToProject || relativeToProject.startsWith('..') || path.isAbsolute(relativeToProject) || !fs.statSync(imageFile).isFile()) fail('TILESET_RESOURCE_INVALID', 'Tileset image source must be a regular file inside the project.', 422, { identifier });
    } catch (error) {
        if (error instanceof ToolError) throw error;
        fail('TILESET_RESOURCE_UNAVAILABLE', 'Tileset image source is not readable.', 422, { identifier });
    }
    const source = path.relative(path.dirname(destinationFile), imageFile).replace(/\\/g, '/');
    if (!source || source === '.' || source.includes('\u0000')) fail('TILESET_RESOURCE_INVALID', 'Tileset image cannot be represented as a safe relative TMX image source.', 422, { identifier });
    return { url: info.url, file: imageFile, source, reference: { id: info.uuid, type: info.type ?? 'cc.ImageAsset' } };
}

function assertExactFields(value: Record<string, unknown>, allowed: string[], label: string): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('INVALID_ARGUMENT', `${label} contains unsupported field '${key}'.`);
}
function normalizeInput(raw: unknown): TilemapCreateArgs {
    const input = record(raw);
    if (!input) fail('INVALID_ARGUMENT', 'tilemapCreate input must be an object.');
    assertExactFields(input, ['write', 'assetPath', 'width', 'height', 'tileWidth', 'tileHeight', 'layers', 'tilesets'], 'tilemapCreate');
    if (input.write !== true) fail('WRITE_CONTRACT_REQUIRED', 'tilemapCreate requires explicit write=true.', 400);
    const width = integer(input.width, 'width', 1, MAX_DIMENSION);
    const height = integer(input.height, 'height', 1, MAX_DIMENSION);
    if (width * height > MAX_CELLS) fail('LIMIT_EXCEEDED', `Tilemap cell budget must not exceed ${MAX_CELLS}.`);
    const tileWidth = integer(input.tileWidth, 'tileWidth', 1, 4096);
    const tileHeight = integer(input.tileHeight, 'tileHeight', 1, 4096);
    if (!Array.isArray(input.layers) || input.layers.length < 1 || input.layers.length > MAX_LAYERS) fail('INVALID_ARGUMENT', `layers must contain 1 to ${MAX_LAYERS} finite tile layers.`);
    if (!Array.isArray(input.tilesets) || input.tilesets.length < 1 || input.tilesets.length > MAX_TILESETS) fail('INVALID_ARGUMENT', `tilesets must contain 1 to ${MAX_TILESETS} entries.`);
    const layers: TilemapLayer[] = [];
    const layerNames = new Set<string>();
    const layerIds = new Set<number>();
    for (let index = 0; index < input.layers.length; index++) {
        const layer = record(input.layers[index]);
        if (!layer) fail('INVALID_ARGUMENT', `layers[${index}] must be an object.`);
        assertExactFields(layer, ['id', 'name', 'data'], `layers[${index}]`);
        const name = text(layer.name, `layers[${index}].name`);
        if (layerNames.has(name)) fail('TILEMAP_LAYER_CONFLICT', `Duplicate tile layer name '${name}'.`, 409);
        layerNames.add(name);
        const id = layer.id === undefined ? index + 1 : integer(layer.id, `layers[${index}].id`, 1, 2_000_000_000);
        if (layerIds.has(id)) fail('TILEMAP_LAYER_CONFLICT', `Duplicate tile layer id '${id}'.`, 409);
        layerIds.add(id);
        if (!Array.isArray(layer.data) || layer.data.length !== width * height) fail('INVALID_ARGUMENT', `layers[${index}].data must contain exactly width*height tile IDs.`);
        const data = layer.data.map((gid, cell) => integer(gid, `layers[${index}].data[${cell}]`, 0, 0x1fffffff));
        layers.push({ id, name, data });
    }
    const tilesets: TilemapTileset[] = [];
    const firstGids = new Set<number>();
    for (let index = 0; index < input.tilesets.length; index++) {
        const tileset = record(input.tilesets[index]);
        if (!tileset) fail('INVALID_ARGUMENT', `tilesets[${index}] must be an object.`);
        assertExactFields(tileset, ['name', 'image', 'firstGid', 'tileCount', 'columns'], `tilesets[${index}]`);
        const firstGid = integer(tileset.firstGid, `tilesets[${index}].firstGid`, 1, 0x1fffffff);
        const tileCount = integer(tileset.tileCount, `tilesets[${index}].tileCount`, 1, 1_000_000);
        const columns = integer(tileset.columns, `tilesets[${index}].columns`, 1, tileCount);
        if (firstGids.has(firstGid)) fail('TILESET_CONFLICT', `Duplicate tileset firstGid '${firstGid}'.`, 409);
        firstGids.add(firstGid);
        const image = record(tileset.image);
        if (!image) fail('INVALID_ARGUMENT', `tilesets[${index}].image must be an object.`);
        assertExactFields(image, ['assetPath', 'reference'], `tilesets[${index}].image`);
        const assetPath = image.assetPath === undefined ? undefined : text(image.assetPath, `tilesets[${index}].image.assetPath`, MAX_PATH);
        const reference = image.reference === undefined ? undefined : image.reference as IInstanceReference;
        if (assetPath === undefined && (!reference || typeof reference.id !== 'string' || !reference.id)) fail('INVALID_ARGUMENT', `tilesets[${index}].image requires assetPath or reference.`);
        tilesets.push({ name: tileset.name === undefined ? undefined : text(tileset.name, `tilesets[${index}].name`), image: { ...(assetPath === undefined ? {} : { assetPath }), ...(reference === undefined ? {} : { reference }) }, firstGid, tileCount, columns });
    }
    const sorted = [...tilesets].sort((left, right) => left.firstGid - right.firstGid);
    for (let index = 1; index < sorted.length; index++) if (sorted[index - 1].firstGid + sorted[index - 1].tileCount > sorted[index].firstGid) fail('TILESET_CONFLICT', 'Tileset GID ranges overlap.', 409);
    const ranges = sorted.map((tileset) => ({ firstGid: tileset.firstGid, lastGid: tileset.firstGid + tileset.tileCount - 1 }));
    for (const layer of layers) for (const gid of layer.data) if (gid !== 0 && !ranges.some((range) => gid >= range.firstGid && gid <= range.lastGid)) fail('TILE_GID_OUT_OF_RANGE', `Tile gid ${gid} is not covered by a declared tileset.`, 422);
    return { write: true, assetPath: normalizeAssetUrl(input.assetPath), width, height, tileWidth, tileHeight, layers, tilesets };
}
async function prepare(raw: unknown): Promise<PreparedTilemap> {
    const args = normalizeInput(raw);
    const targetUrl = args.assetPath;
    const targetFile = targetFileForUrl(targetUrl);
    assertNewPath(targetUrl, targetFile);
    const existing = await queryAsset(targetUrl);
    if (existing) fail('TILEMAP_SOURCE_CONFLICT', 'Tilemap asset already exists; overwrite and rename are disabled.', 409, { assetPath: targetUrl });
    const images: ResolvedImage[] = [];
    for (const tileset of args.tilesets) images.push(await resolveImage(tileset.image, targetFile));
    const imageByTileset = new Map<TilemapTileset, ResolvedImage>();
    args.tilesets.forEach((tileset, index) => imageByTileset.set(tileset, images[index]));
    const tilesetsXml = args.tilesets.map((tileset) => {
        const image = imageByTileset.get(tileset);
        if (!image) fail('TILESET_RESOURCE_INVALID', 'Tileset image resolution was lost before TMX generation.', 422);
        return `  <tileset firstgid="${tileset.firstGid}" name="${escapeXml(tileset.name ?? path.basename(image.url, path.extname(image.url)))}" tilewidth="${args.tileWidth}" tileheight="${args.tileHeight}" tilecount="${tileset.tileCount}" columns="${tileset.columns}">\n    <image source="${escapeXml(image.source)}"/>\n  </tileset>`;
    }).join('\n');
    const layersXml = args.layers.map((layer) => `  <layer id="${layer.id}" name="${escapeXml(layer.name)}" width="${args.width}" height="${args.height}">\n    <data encoding="csv">${layer.data.join(',')}</data>\n  </layer>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<map version="1.10" tiledversion="1.10.2" orientation="orthogonal" renderorder="right-down" width="${args.width}" height="${args.height}" tilewidth="${args.tileWidth}" tileheight="${args.tileHeight}" infinite="0">\n${tilesetsXml}\n${layersXml}\n</map>\n`;
    if (Buffer.byteLength(xml, 'utf8') > MAX_SOURCE_BYTES) fail('LIMIT_EXCEEDED', `Generated TMX source exceeds ${MAX_SOURCE_BYTES} bytes.`);
    return { args, targetUrl, targetFile, xml, images };
}
async function readSource(file: string): Promise<{ bytes: Buffer; hash: string }> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_SOURCE_BYTES) fail('TILEMAP_SOURCE_READBACK_FAILED', 'Generated TMX source could not be read back within the bounded limit.', 502);
    const bytes = await fs.readFile(file);
    return { bytes, hash: sha256(bytes) };
}
async function waitForImported(uuid: string): Promise<AssetInfoLike> {
    let last: AssetInfoLike | null = null;
    for (let attempt = 0; attempt < 40; attempt++) {
        last = await queryAsset(uuid);
        if (last?.invalid === true) fail('TILEMAP_IMPORT_FAILED', 'Creator rejected the generated TMX source.', 502, { sourceCreated: true, import: 'failed', asset: { uuid } });
        if (last?.type === 'cc.TiledMapAsset' && last.imported !== false) return last;
        if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    fail('TILEMAP_IMPORT_TIMEOUT', 'Creator did not expose a cc.TiledMapAsset read-back within the bounded import deadline.', 504, { sourceCreated: true, import: 'unknown', asset: { uuid, lastType: last?.type ?? null, imported: last?.imported ?? null } });
}

export class TilemapCreateTools {
    @utcpTool('tilemapCreate', 'Generate deterministic bounded TMX source, import it through Creator Asset DB, and validate typed tilemap read-back. This creates a TMX source representation, never a native tilemap authoring object.', {
        type: 'object', additionalProperties: false,
        properties: {
            write: { type: 'boolean', const: true },
            assetPath: { type: 'string', pattern: '^db://assets/[A-Za-z0-9._/-]+\\.tmx$' },
            width: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION }, height: { type: 'integer', minimum: 1, maximum: MAX_DIMENSION },
            tileWidth: { type: 'integer', minimum: 1, maximum: 4096 }, tileHeight: { type: 'integer', minimum: 1, maximum: 4096 },
            layers: { type: 'array', minItems: 1, maxItems: MAX_LAYERS, items: { type: 'object', additionalProperties: false, properties: { id: { type: 'integer' }, name: { type: 'string', minLength: 1, maxLength: 256 }, data: { type: 'array', minItems: 1, maxItems: MAX_CELLS, items: { type: 'integer', minimum: 0, maximum: 0x1fffffff } } }, required: ['name', 'data'] } },
            tilesets: { type: 'array', minItems: 1, maxItems: MAX_TILESETS, items: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 256 }, image: { type: 'object', additionalProperties: false, properties: { assetPath: { type: 'string' }, reference: InstanceReferenceSchema } }, firstGid: { type: 'integer', minimum: 1 }, tileCount: { type: 'integer', minimum: 1 }, columns: { type: 'integer', minimum: 1 } }, required: ['image', 'firstGid', 'tileCount', 'columns'] } },
        }, required: ['write', 'assetPath', 'width', 'height', 'tileWidth', 'tileHeight', 'layers', 'tilesets'],
    }, {
        type: 'object', additionalProperties: false, properties: {
            representation: { type: 'string', const: 'tmx-source' }, nativeCreated: { type: 'boolean', const: false }, source: { type: 'object' }, asset: { type: 'object' }, import: { type: 'object' }, validation: { type: 'object' }, readBack: { type: 'object' },
        }, required: ['representation', 'nativeCreated', 'source', 'asset', 'import', 'validation', 'readBack'],
    }, 'POST', ['tilemap', 'create', 'tmx', 'source', 'import'])
    async tilemapCreate(raw: unknown): Promise<Record<string, unknown>> {
        const prepared = await prepare(raw);
        const expected = Buffer.from(prepared.xml, 'utf8');
        const expectedHash = sha256(expected);
        let created: AssetInfoLike | null = null;
        try {
            created = await Editor.Message.request('asset-db', 'create-asset', prepared.targetUrl, prepared.xml, { overwrite: false, rename: false }) as AssetInfoLike | null;
        } catch (error) {
            const observed = await queryAsset(prepared.targetUrl);
            fail('TILEMAP_SOURCE_CREATE_FAILED', 'Creator Asset DB rejected TMX source creation; no success is claimed.', 502, { sourceCreated: !!observed, import: observed ? 'unknown' : 'not-started', assetPath: prepared.targetUrl, cause: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256) });
        }
        if (!created?.uuid) {
            const observed = await queryAsset(prepared.targetUrl);
            fail('TILEMAP_SOURCE_CREATE_FAILED', 'Creator Asset DB did not acknowledge TMX source creation.', 502, { sourceCreated: !!observed, import: observed ? 'unknown' : 'not-started', assetPath: prepared.targetUrl });
        }
        const sourceReadback = await readSource(prepared.targetFile);
        if (sourceReadback.hash !== expectedHash || !sourceReadback.bytes.equals(expected)) fail('TILEMAP_SOURCE_READBACK_MISMATCH', 'TMX source read-back differs from the deterministic generated source; inspect before retrying.', 502, { sourceCreated: true, import: 'unknown', asset: { uuid: created.uuid, url: prepared.targetUrl }, expectedSha256: expectedHash, actualSha256: sourceReadback.hash });
        const imported = await waitForImported(created.uuid);
        if (imported.type !== 'cc.TiledMapAsset') fail('TILEMAP_IMPORT_TYPE_MISMATCH', 'Creator imported the TMX source without exposing cc.TiledMapAsset.', 502, { sourceCreated: true, import: 'failed', asset: { uuid: imported.uuid, type: imported.type ?? null } });
        const importedUuid = typeof imported.uuid === 'string' ? imported.uuid : created.uuid;
        const importedType = imported.type ?? 'cc.TiledMapAsset';
        const importedMeta = await Editor.Message.request('asset-db', 'query-asset-meta', importedUuid).catch(() => null) as unknown;
        if (!importedMeta || typeof importedMeta !== 'object' || Array.isArray(importedMeta)) fail('TILEMAP_IMPORT_META_UNAVAILABLE', 'Creator imported the TMX source but did not expose native tilemap metadata.', 502, { sourceCreated: true, import: 'failed', asset: { uuid: importedUuid, type: importedType }, meta: 'unavailable' });
        const reference: IInstanceReference = { id: importedUuid, type: importedType };
        let readBack: Record<string, unknown>;
        let validation: Record<string, unknown>;
        try {
            const consumer = new AdvancedCapabilityTools();
            readBack = await consumer.tilemapInspect({ reference });
            validation = await consumer.tilemapValidate({ reference });
        } catch (error) {
            fail('TILEMAP_VALIDATION_FAILED', 'TMX source and native import exist, but existing tilemap inspection/validation consumers could not read them back.', 502, { sourceCreated: true, import: 'succeeded', validation: 'failed', asset: { uuid: importedUuid, type: importedType }, cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) });
        }
        if (validation.valid !== true) fail('TILEMAP_VALIDATION_FAILED', 'Generated TMX imported but existing tilemap validation reported invalid structure.', 422, { sourceCreated: true, import: 'succeeded', validation: 'invalid', asset: { uuid: importedUuid, type: importedType }, validationResult: validation });
        return {
            representation: 'tmx-source', nativeCreated: false,
            source: { created: true, url: prepared.targetUrl, sha256: sourceReadback.hash, bytes: sourceReadback.bytes.length, format: 'tmx' },
            asset: { reference, url: typeof imported.url === 'string' ? imported.url : prepared.targetUrl, type: importedType, importer: imported.importer ?? null },
            import: { status: 'succeeded', nativeCreated: false, type: importedType },
            validation: { status: 'succeeded', valid: true, result: validation },
            readBack,
        };
    }
}
