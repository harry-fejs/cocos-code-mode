import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { ToolError } from './utcp/tool-error';

export const COMPONENT_PROPERTY_TYPES = ['number', 'string', 'boolean', 'Vec2', 'Vec3', 'Node', 'AudioClip', 'AnimationClip', 'SpriteFrame'] as const;
export type ComponentPropertyType = typeof COMPONENT_PROPERTY_TYPES[number];
export type ComponentPropertyDescriptor =
    | { name: string; type: 'number'; default?: number }
    | { name: string; type: 'string'; default?: string }
    | { name: string; type: 'boolean'; default?: boolean }
    | { name: string; type: 'Vec2'; default?: { x: number; y: number } }
    | { name: string; type: 'Vec3'; default?: { x: number; y: number; z: number } }
    | { name: string; type: 'Node' | 'AudioClip' | 'AnimationClip' | 'SpriteFrame'; default?: null };
export interface ComponentScriptDescriptor { className: string; properties?: ComponentPropertyDescriptor[] }
export interface ComponentScriptSource { source: string; sha256: string; bytes: number; className: string }
export interface ComponentScriptPath { assetUrl: string; file: string; parentUrl: string; parent: string }
export interface ComponentScriptAsset { uuid: string; url: string; file: string; isDirectory?: boolean }
const MAX_SOURCE_BYTES = 64 * 1024;
const RESERVED: Record<string, boolean> = Object.fromEntries(('abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get global if implements import in infer instanceof interface intrinsic is keyof let module namespace never new null number object of out override package private protected public readonly require return satisfies set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield arguments eval _decorator Component Node AudioClip AnimationClip SpriteFrame CCFloat CCString CCBoolean ccclass property').split(' ').map(name => [name, true]));
const COMPONENT_MEMBERS: Record<string, boolean> = Object.fromEntries(('name uuid node enabled enabledInHierarchy isValid hideFlags addComponent getComponent getComponents getComponentInChildren getComponentsInChildren destroy schedule scheduleOnce unschedule unscheduleAllCallbacks onLoad start update lateUpdate onEnable onDisable onDestroy resetInEditor onFocusInEditor onLostFocusInEditor onRestore toString toLocaleString valueOf hasOwnProperty isPrototypeOf propertyIsEnumerable').split(' ').map(name => [name, true]));
const PROPERTY_IMPORTS: Record<ComponentPropertyType, string> = { number: 'CCFloat', string: 'CCString', boolean: 'CCBoolean', Vec2: 'Vec2', Vec3: 'Vec3', Node: 'Node', AudioClip: 'AudioClip', AnimationClip: 'AnimationClip', SpriteFrame: 'SpriteFrame' };
function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }
export function assertComponentScriptInput(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid('Component script input must be an object containing only supported fields.');
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && RESERVED[value] !== true; }
function literal(value: string | number | boolean | null): string { return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'); }
export function componentScriptHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/** Deterministic data-component authoring only; never evaluates source or invokes lifecycle methods. */
export function generateComponentScriptSource(input: unknown): ComponentScriptSource {
    assertComponentScriptInput(input, ['className', 'properties']);
    if (!identifier(input.className)) invalid('className must be a non-reserved ASCII identifier of 1 to 64 characters beginning with a letter.');
    const rows = input.properties === undefined ? [] : input.properties;
    if (!Array.isArray(rows) || rows.length > 64) invalid('properties must contain at most 64 typed field descriptors.');
    const imports = new Set<string>(['_decorator', 'Component']);
    const names = new Set<string>();
    const fields: string[] = [];
    for (const row of rows) {
        assertComponentScriptInput(row, ['name', 'type', 'default']);
        if (!identifier(row.name) || COMPONENT_MEMBERS[row.name] === true || names.has(row.name)) invalid('Property names must be unique safe identifiers and must not shadow Component members or lifecycle methods.');
        if (typeof row.type !== 'string' || !COMPONENT_PROPERTY_TYPES.includes(row.type as ComponentPropertyType)) invalid('Unsupported property type.');
        const type = row.type as ComponentPropertyType;
        const hasDefault = Object.prototype.hasOwnProperty.call(row, 'default');
        let initial: string | number | boolean | null;
        if (type === 'Vec2' || type === 'Vec3') {
            const axes = type === 'Vec2' ? ['x', 'y'] : ['x', 'y', 'z'];
            const value = hasDefault ? row.default : Object.fromEntries(axes.map(axis => [axis, 0]));
            assertComponentScriptInput(value, axes);
            if (axes.some(axis => typeof value[axis] !== 'number' || !Number.isFinite(value[axis]))) invalid('Vector defaults require exactly the finite numeric coordinates of their declared type.');
            names.add(row.name);
            imports.add(type);
            fields.push(`    @property(${type})`, `    ${row.name}: ${type} = new ${type}(${axes.map(axis => literal(value[axis] as number)).join(', ')});`, '');
            continue;
        }
        if (type === 'number') {
            if (hasDefault && (typeof row.default !== 'number' || !Number.isFinite(row.default))) invalid('Number defaults must be finite numbers.');
            initial = hasDefault ? row.default as number : 0;
        } else if (type === 'string') {
            if (hasDefault && (typeof row.default !== 'string' || row.default.length > 4096)) invalid('String defaults must be strings of at most 4096 characters.');
            initial = hasDefault ? row.default as string : '';
        } else if (type === 'boolean') {
            if (hasDefault && typeof row.default !== 'boolean') invalid('Boolean defaults must be booleans.');
            initial = hasDefault ? row.default as boolean : false;
        } else {
            if (hasDefault && row.default !== null) invalid('Reference defaults must be null; assign actual references separately in the Inspector.');
            initial = null;
        }
        names.add(row.name);
        imports.add(PROPERTY_IMPORTS[type]);
        fields.push(`    @property(${PROPERTY_IMPORTS[type]})`, `    ${row.name}: ${initial === null ? `${type} | null` : type} = ${literal(initial)};`, '');
    }
    if (imports.has(input.className)) invalid('className must not shadow a generated cc import.');
    const source = [
        '// Project-owned Creator 3.7 data component; serialized fields only, no gameplay or lifecycle behavior.',
        `import { ${[...imports].join(', ')} } from 'cc';`,
        `const { ccclass${fields.length ? ', property' : ''} } = _decorator;`,
        `@ccclass(${literal(input.className)})`,
        `export class ${input.className} extends Component {`,
        ...fields,
        '}', '',
    ].join('\n');
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > MAX_SOURCE_BYTES) throw new ToolError({ code: 'PAYLOAD_TOO_LARGE', status: 413, message: 'Generated component source exceeds 64 KiB.' });
    return { source, sha256: componentScriptHash(source), bytes, className: input.className };
}

export function resolveComponentScriptPath(assetUrl: unknown): ComponentScriptPath {
    if (typeof assetUrl !== 'string' || assetUrl.length > 512 || !/^db:\/\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z][A-Za-z0-9_-]*\.ts$/.test(assetUrl)) invalid('assetUrl must be an exact db://assets/.../*.ts path with bounded safe path segments.');
    const project = typeof Editor.Project?.path === 'string' ? Editor.Project.path : '';
    if (!project) throw new ToolError({ code: 'PROJECT_UNAVAILABLE', status: 503, message: 'An open Creator project is required.' });
    try {
        const root = fs.realpathSync(project);
        const file = path.resolve(root, assetUrl.slice('db://'.length));
        const parent = fs.realpathSync(path.dirname(file));
        const relative = path.relative(root, parent);
        if ((relative !== 'assets' && !relative.startsWith(`assets${path.sep}`)) || path.resolve(parent, path.basename(file)) !== file) invalid('Component source parent must be project-owned assets, without symlink directory aliases.');
        if (!fs.statSync(parent).isDirectory()) throw new Error('Not a directory');
        return { assetUrl, file, parent, parentUrl: assetUrl.slice(0, assetUrl.lastIndexOf('/')) };
    } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Component source requires an existing accessible project assets parent directory.' });
    }
}
export async function queryComponentScriptAsset(url: string): Promise<ComponentScriptAsset | null> {
    let info: unknown;
    try { info = await Editor.Message.request('asset-db', 'query-asset-info', url); }
    catch { throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB query failed; source ownership is unconfirmed.' }); }
    if (info === null) return null;
    if (!info || typeof info !== 'object') throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB returned an invalid asset identity; absence is not confirmed.' });
    const row = info as Record<string, unknown>;
    if (typeof row.uuid !== 'string' || !row.uuid || typeof row.url !== 'string' || typeof row.file !== 'string') throw new ToolError({ code: 'ASSET_QUERY_FAILED', status: 502, message: 'Asset DB returned incomplete asset ownership information.' });
    return { uuid: row.uuid, url: row.url, file: row.file, isDirectory: row.isDirectory === true };
}
export async function preflightComponentScriptPath(assetUrl: string): Promise<ComponentScriptPath> {
    const source = resolveComponentScriptPath(assetUrl);
    const parent = await queryComponentScriptAsset(source.parentUrl);
    if (!parent || !parent.isDirectory || parent.url !== source.parentUrl || path.resolve(parent.file) !== source.parent) throw new ToolError({ code: 'SOURCE_PARENT_UNCONFIRMED', status: 409, message: 'Asset DB must confirm the exact existing project-owned parent directory.' });
    if (await queryComponentScriptAsset(assetUrl)) throw new ToolError({ code: 'SOURCE_CONFLICT', status: 409, message: 'Component source creation never overwrites or renames an existing Asset DB entry.' });
    for (const file of [source.file, `${source.file}.meta`]) {
        try { fs.lstatSync(file); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw new ToolError({ code: 'SOURCE_ACCESS_FAILED', status: 502, message: 'Cannot confirm absence of the requested source or metadata; no mutation was attempted.' });
        }
        throw new ToolError({ code: 'SOURCE_CONFLICT', status: 409, message: 'Component source creation refuses existing source or metadata entries, including dangling symlinks.' });
    }
    const current = resolveComponentScriptPath(assetUrl);
    if (current.file !== source.file || current.parent !== source.parent) throw new ToolError({ code: 'SOURCE_PARENT_CHANGED', status: 409, message: 'Source parent changed during preflight; no mutation was attempted.' });
    return source;
}
export async function readComponentScriptSource(source: ComponentScriptPath, uuid: string, expected: ComponentScriptSource): Promise<void> {
    let fd: number | undefined;
    try {
        const info = await queryComponentScriptAsset(source.assetUrl);
        const current = resolveComponentScriptPath(source.assetUrl);
        if (!info || info.uuid !== uuid || info.url !== source.assetUrl || path.resolve(info.file) !== source.file || current.file !== source.file || fs.lstatSync(source.file).isSymbolicLink() || fs.realpathSync(source.file) !== source.file) throw new Error('Source identity mismatch');
        fd = fs.openSync(source.file, 'r');
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size !== expected.bytes) throw new Error('Source size mismatch');
        const bytes = Buffer.alloc(expected.bytes + 1);
        let count = 0;
        while (count < bytes.length) {
            const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
            if (!read) break;
            count += read;
        }
        if (count !== expected.bytes || componentScriptHash(bytes.subarray(0, count)) !== expected.sha256) throw new Error('Source hash mismatch');
    } catch {
        throw new ToolError({ code: 'SOURCE_READBACK_UNCONFIRMED', status: 502, message: 'Created source identity/content could not be confirmed. Source may exist; no retry or deletion was attempted.', details: { assetUrl: source.assetUrl, expectedSha256: expected.sha256, sourceCreated: null, classRegistration: 'unknown', attached: false, runtimeVerified: false, sceneSaved: false } });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}
