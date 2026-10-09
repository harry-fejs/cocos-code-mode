import { isDeepStrictEqual } from 'util';
import { ToolError } from './tool-error';
import { buildBuildPresetAudit } from '../build-preset-audit';
import packageJSON from '../../package.json';

export const BUILD_SETTING_RULES: Record<string, 'boolean' | 'string'> = {
    'common.name': 'string', 'common.server': 'string', 'common.platform': 'string', 'common.buildPath': 'string',
    'common.debug': 'boolean', 'common.md5Cache': 'boolean', 'common.skipCompressTexture': 'boolean', 'common.sourceMaps': 'boolean',
    useBuildAssetCache: 'boolean', useBuildEngineCache: 'boolean', useBuildTextureCompressCache: 'boolean', useBuildAutoAtlasCache: 'boolean',
    supportTaskQueue: 'boolean', 'serializedOptions.keepNodeUuid': 'boolean',
};
const PLATFORMS = new Set(['web-mobile', 'web-desktop', 'android', 'ios', 'windows', 'mac']);
const MAX_PROFILE_BYTES = 32768;
const MAX_PROFILES = 32;
let writing = false;
type Options = Record<string, unknown>;
export interface BuildProfileArgs { operation: 'list' | 'get' | 'save' | 'delete'; name?: string; options?: Options }
export interface BuildSettingsArgs { operation: 'get' | 'set'; key?: string; value?: string | boolean; scope?: 'local' | 'global' }
function invalid(message: string): never { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); }
function requireProfileApi(methods: Array<keyof typeof Editor.Profile>): void {
    if (!Editor.Profile || methods.some(method => typeof Editor.Profile[method] !== 'function')) {
        throw new ToolError({ code: 'UNSUPPORTED_EDITOR_API', status: 422, message: 'Creator Profile API is unavailable.', recovery: 'Use a Creator version exposing the required Profile methods; no filesystem fallback is used.' });
    }
}
async function transaction<T>(run: () => Promise<T>): Promise<T> {
    if (writing) throw new ToolError({ code: 'BUILD_PROFILE_BUSY', status: 409, message: 'Another build profile/settings write is pending.', recovery: 'Read the current profile after the pending write completes.' });
    writing = true;
    try { return await run(); } finally { writing = false; }
}
async function persist(write: () => Promise<void>, verify: () => Promise<boolean>, rollback: () => Promise<void>, restored: () => Promise<boolean>): Promise<void> {
    try {
        await write();
        if (!await verify()) throw new Error('Persisted value did not match the requested value.');
    } catch {
        try {
            await rollback();
            if (!await restored()) throw new Error('Rollback read-back mismatch.');
        } catch {
            throw new ToolError({ code: 'BUILD_PROFILE_ROLLBACK_FAILED', status: 500, message: 'Build configuration write and restoration were not confirmed.', recovery: 'Inspect Creator build settings before any further write or build.' });
        }
        throw new ToolError({ code: 'BUILD_PROFILE_WRITE_FAILED', status: 502, message: 'Build configuration write was not confirmed; previous value restored.', recovery: 'Inspect the supported setting/profile values before retrying.' });
    }
}
function cleanOptions(value: unknown): Options {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Build profile options must be an object.');
    let serialized: string;
    try { serialized = JSON.stringify(value); } catch { return invalid('Build profile options must be serializable JSON.'); }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_PROFILE_BYTES) invalid('Build profile exceeds 32768 UTF-8 bytes.');
    const options = JSON.parse(serialized) as Options;
    // Credentials belong to Creator/OS secret storage, never reusable profiles or tool output.
    const visit = (entry: unknown, depth: number): void => {
        if (depth > 16) invalid('Build profile exceeds maximum nesting depth.');
        if (!entry || typeof entry !== 'object') return;
        for (const [key, child] of Object.entries(entry)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key) || /password|secret|token|credential|privatekey/i.test(key)) invalid('Build profile contains an unsafe or credential field; remove it before saving.');
            visit(child, depth + 1);
        }
    };
    visit(options, 0);
    const { platform, ...presetOptions } = options;
    const audit = buildBuildPresetAudit(platform, presetOptions);
    if (options.packages && typeof options.packages === 'object' && !Array.isArray(options.packages)) {
        const target = (options.packages as Record<string, unknown>)[String(platform)];
        if (target !== undefined) {
            const targetAudit = buildBuildPresetAudit(platform, target);
            audit.errors.push(...targetAudit.errors);
            audit.valid = audit.valid && targetAudit.valid;
            audit.complete = audit.complete && targetAudit.complete;
        }
    }
    if (!audit.valid || !audit.complete) throw new ToolError({ code: 'INVALID_BUILD_PROFILE', status: 400, message: 'Build options failed the target profile audit.', details: { errors: audit.errors }, recovery: 'Run buildPresetAudit and correct the reported options.' });
    return options;
}
async function profiles(): Promise<Record<string, Options>> {
    const value: unknown = await Editor.Profile.getProject(packageJSON.name, 'buildProfiles', 'project');
    if (value === undefined || value === null) return Object.create(null);
    if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_PROFILES || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PROFILE_BYTES * MAX_PROFILES) {
        throw new ToolError({ code: 'BUILD_PROFILE_INVALID_STORAGE', status: 422, message: 'Stored build profile collection is invalid or exceeds bounds.' });
    }
    const result: Record<string, Options> = Object.create(null);
    for (const [name, options] of Object.entries(value)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name)) throw new ToolError({ code: 'BUILD_PROFILE_INVALID_STORAGE', status: 422, message: 'Stored build profile name is invalid.' });
        result[name] = cleanOptions(options);
    }
    return result;
}
export async function manageBuildProfiles(args: BuildProfileArgs) {
    requireProfileApi(['getProject']);
    if (args.operation === 'list') {
        const stored = await profiles();
        return { profiles: Object.entries(stored).map(([name, options]) => ({ name, platform: options.platform })), total: Object.keys(stored).length, storage: 'ccp project profiles; not Creator build task history' };
    }
    if (!args.name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.name) || ['constructor', 'prototype'].includes(args.name)) invalid('Profile name must be 1..64 alphanumeric, underscore or hyphen characters.');
    if (!['get', 'save', 'delete'].includes(args.operation)) invalid('Unknown build profile operation.');
    if (args.operation === 'get') {
        const options = (await profiles())[args.name];
        if (!options) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Build profile not found.' });
        return { name: args.name, options };
    }
    const options = args.operation === 'save' ? cleanOptions(args.options) : undefined;
    requireProfileApi(['setProject', 'removeProject']);
    return transaction(async () => {
        const rawBefore = await Editor.Profile.getProject(packageJSON.name, 'buildProfiles', 'project');
        const before = await profiles();
        const next = { ...before };
        if (args.operation === 'save') {
            if (!before[args.name!] && Object.keys(before).length >= MAX_PROFILES) invalid('At most 32 build profiles may be saved.');
            next[args.name!] = options!;
        } else {
            if (!before[args.name!]) throw new ToolError({ code: 'TARGET_NOT_FOUND', status: 404, message: 'Build profile not found.' });
            delete next[args.name!];
        }
        await persist(() => Editor.Profile.setProject(packageJSON.name, 'buildProfiles', next, 'project'),
            async () => isDeepStrictEqual(await profiles(), Object.assign(Object.create(null), next)),
            () => rawBefore === undefined ? Editor.Profile.removeProject(packageJSON.name, 'buildProfiles', 'project') : Editor.Profile.setProject(packageJSON.name, 'buildProfiles', rawBefore, 'project'),
            async () => isDeepStrictEqual(await Editor.Profile.getProject(packageJSON.name, 'buildProfiles', 'project'), rawBefore));
        return { success: true, name: args.name, operation: args.operation };
    });
}
export async function manageBuildSettings(args: BuildSettingsArgs) {
    requireProfileApi(['getConfig']);
    const scope = args.scope ?? 'local';
    if (scope !== 'local' && scope !== 'global') invalid('Build settings scope must be local or global.');
    if (args.operation !== 'get' && args.operation !== 'set') invalid('Unknown build settings operation.');
    if (args.key !== undefined && !Object.prototype.hasOwnProperty.call(BUILD_SETTING_RULES, args.key)) invalid('Unsupported build setting key.');
    if (args.operation === 'get') {
        const settings: Record<string, unknown> = {};
        for (const key of args.key ? [args.key] : Object.keys(BUILD_SETTING_RULES)) {
            const value: unknown = await Editor.Profile.getConfig('builder', key, scope);
            if (value !== undefined && value !== null && (typeof value !== BUILD_SETTING_RULES[key] || (typeof value === 'string' && value.length > 2048))) throw new ToolError({ code: 'BUILD_SETTINGS_INVALID_RESPONSE', status: 502, message: 'Creator returned an invalid build setting value.' });
            settings[key] = value ?? null;
        }
        return { scope, settings, affectsExistingTasks: false };
    }
    if (!args.key || typeof args.value !== BUILD_SETTING_RULES[args.key]) invalid('Setting key and matching typed value are required.');
    if (typeof args.value === 'string' && (args.value.length > 2048 || /[\x00-\x1f]/.test(args.value))) invalid('Setting string is too long or contains control characters.');
    if (args.key === 'common.platform' && !PLATFORMS.has(String(args.value))) invalid('Unsupported build target platform.');
    requireProfileApi(['setConfig', 'removeConfig']);
    return transaction(async () => {
        const before = await Editor.Profile.getConfig('builder', args.key!, scope);
        await persist(() => Editor.Profile.setConfig('builder', args.key!, args.value!, scope),
            async () => isDeepStrictEqual(await Editor.Profile.getConfig('builder', args.key!, scope), args.value),
            () => before === undefined ? Editor.Profile.removeConfig('builder', args.key!, scope) : Editor.Profile.setConfig('builder', args.key!, before, scope),
            async () => isDeepStrictEqual(await Editor.Profile.getConfig('builder', args.key!, scope), before));
        return { success: true, key: args.key, value: args.value, scope, affectsExistingTasks: false };
    });
}

export interface BuildTemplateArgs {
    operation: 'list' | 'create'; platform?: string; mode?: 'debug' | 'release'; name?: string;
    scenes?: Array<{ uuid: string; url: string }>; startScene?: string; packageName?: string;
    orientation?: 'auto' | 'portrait' | 'landscape'; buildPath?: string; remoteServerAddress?: string;
}
export function createBuildTemplate(args: BuildTemplateArgs) {
    if (args.operation === 'list') return { platforms: [...PLATFORMS], modes: ['debug', 'release'], writes: false };
    if (args.operation !== 'create' || !args.platform || !PLATFORMS.has(args.platform)) invalid('Choose a supported platform from buildTemplate list.');
    if (args.mode !== undefined && args.mode !== 'debug' && args.mode !== 'release') invalid('Build mode must be debug or release.');
    if (!args.name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.name)) invalid('Build name must be 1..64 alphanumeric, underscore or hyphen characters.');
    if (!Array.isArray(args.scenes) || args.scenes.length < 1 || args.scenes.length > 512) invalid('Provide 1..512 real build scenes.');
    const ids = new Set<string>();
    for (const scene of args.scenes) {
        if (!scene || typeof scene.uuid !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(scene.uuid)
            || typeof scene.url !== 'string' || !/^db:\/\/assets\/.+\.scene$/.test(scene.url) || scene.url.length > 512 || /[\x00-\x1f]/.test(scene.url) || scene.url.split('/').includes('..') || ids.has(scene.uuid)) invalid('Scenes require unique UUIDs and bounded db://assets/*.scene URLs.');
        ids.add(scene.uuid);
    }
    const startScene = args.startScene ?? args.scenes[0].uuid;
    if (!ids.has(startScene)) invalid('startScene must be included in scenes.');
    const orientation = args.orientation ?? 'landscape';
    if (!['auto', 'portrait', 'landscape'].includes(orientation)) invalid('Invalid build orientation.');
    const native = args.platform === 'android' || args.platform === 'ios';
    if (native && (!args.packageName || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(args.packageName) || args.packageName.length > 256)) invalid('Android/iOS require a real reverse-domain packageName.');
    if (!native && args.packageName !== undefined) invalid('packageName is only supported by Android/iOS templates.');
    if (args.remoteServerAddress !== undefined) {
        try {
            const url = new URL(args.remoteServerAddress);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('Remote server must be an HTTP(S) URL without credentials, query or fragment.');
        } catch { invalid('Invalid remote server address.'); }
    }
    const debug = args.mode !== 'release';
    const options: Options = {
        platform: args.platform, name: args.name, outputName: `${args.platform}-${debug ? 'debug' : 'release'}`,
        buildPath: args.buildPath ?? 'project://build', debug, sourceMaps: debug, md5Cache: !native && !debug,
        mainBundleIsRemote: false, mainBundleCompressionType: 'merge_dep', useBuiltinServer: false,
        skipCompressTexture: false, experimentalEraseModules: false, polyfills: { asyncFunctions: false },
        scenes: args.scenes.map(scene => ({ uuid: scene.uuid, url: scene.url, inBundle: false })), startScene,
    };
    if (args.remoteServerAddress) options.remoteServerAddress = args.remoteServerAddress;
    if (args.platform === 'web-mobile') options.orientation = orientation;
    if (native) {
        const target: Options = { packageName: args.packageName, orientation: { portrait: orientation !== 'landscape', upsideDown: false, landscapeRight: orientation !== 'portrait', landscapeLeft: orientation !== 'portrait' } };
        if (args.platform === 'android') Object.assign(target, { appABIs: ['arm64-v8a'], useDebugKeystore: debug, appBundle: false, androidInstant: false, renderBackEnd: { vulkan: false, gles3: true, gles2: true } });
        else Object.assign(target, { skipUpdateXcodeProject: false, renderBackEnd: { metal: true, gles3: false, gles2: false }, osTarget: { iphoneos: true, simulator: false } });
        options.packages = { [args.platform]: target };
    }
    return { options: cleanOptions(options), writes: false, readiness: 'options-only; asset existence and native toolchain/signing not verified', requirements: args.platform === 'android' ? ['Android SDK/NDK', ...(debug ? [] : ['Release signing configured in Creator'])] : args.platform === 'ios' ? ['macOS/Xcode', 'Signing configured in Xcode/Creator'] : args.platform === 'windows' ? ['Windows native toolchain'] : args.platform === 'mac' ? ['macOS/Xcode'] : [] };
}
