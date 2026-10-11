import { ToolError } from './tool-error';
import { buildBuildPresetAudit } from '../build-preset-audit';

type Options = Record<string, unknown>;
function object(value: unknown): value is Options { return !!value && typeof value === 'object' && !Array.isArray(value); }
export function boundedBuildOptions(value: unknown): Options {
    if (!object(value)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Build options must be an object.' });
    const visit = (entry: unknown, depth: number): void => {
        if (depth > 16) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Build options exceed nesting bounds.' });
        if (!entry || typeof entry !== 'object') return;
        for (const [key, child] of Object.entries(entry)) {
            if (/password|secret|token|credential|privatekey|xxteaKey/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Signing/credential fields are not accepted by build configuration tools.' });
            visit(child, depth + 1);
        }
    };
    let text: string;
    try { text = JSON.stringify(value); } catch { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Build options must be JSON serializable.' }); }
    if (Buffer.byteLength(text) > 32768) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Build options exceed 32768 bytes.' });
    const options = JSON.parse(text) as Options;
    visit(options, 0);
    return options;
}
export async function inspectBuildPreflight(value: unknown) {
    const options = boundedBuildOptions(value);
    const { platform, ...preset } = options;
    const audit = buildBuildPresetAudit(platform, preset);
    const issues: Array<{ code: string; path: string }> = audit.errors.map(issue => ({ code: issue.code, path: issue.path ?? 'platform' }));
    if (!audit.complete) issues.push({ code: 'INCOMPLETE_OPTIONS', path: 'options' });
    if (object(options.packages) && options.packages[String(platform)] !== undefined) {
        const nested = buildBuildPresetAudit(platform, options.packages[String(platform)]);
        issues.push(...nested.errors.map(issue => ({ code: issue.code, path: `packages.${platform}.${issue.path ?? ''}` })));
        if (!nested.complete) issues.push({ code: 'INCOMPLETE_OPTIONS', path: `packages.${platform}` });
    }
    const config: unknown = await Editor.Message.request('builder', 'query-platform-config' as never);
    if (!object(config) || !object(config.config)) throw new ToolError({ code: 'BUILD_PREFLIGHT_UNAVAILABLE', status: 502, message: 'Creator returned no authoritative target configuration.' });
    const targetAvailable = typeof platform === 'string' && Object.prototype.hasOwnProperty.call(config.config, platform);
    if (!targetAvailable) issues.push({ code: 'TARGET_UNAVAILABLE', path: 'platform' });
    if (!targetAvailable) return { valid: false, complete: true, targetAvailable, sceneCount: 0, issues, writes: false, toolchainVerified: false, signingVerified: false };
    const scenes = options.scenes;
    if (!Array.isArray(scenes) || !scenes.length || scenes.length > 512) issues.push({ code: 'INVALID_SCENES', path: 'scenes' });
    const identities = new Set<string>();
    if (Array.isArray(scenes) && scenes.length <= 512) for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        if (!object(scene) || typeof scene.uuid !== 'string' || !scene.uuid || scene.uuid.length > 128 || typeof scene.url !== 'string' || !/^db:\/\/assets\/(?!.*(?:^|\/)\.\.(?:\/|$)).+\.scene$/.test(scene.url)) { issues.push({ code: 'INVALID_SCENE_IDENTITY', path: `scenes[${i}]` }); continue; }
        if (identities.has(scene.uuid)) issues.push({ code: 'DUPLICATE_SCENE', path: `scenes[${i}]` });
        identities.add(scene.uuid);
        const info: unknown = await Editor.Message.request('asset-db', 'query-asset-info', scene.uuid);
        const byUrl: unknown = await Editor.Message.request('asset-db', 'query-asset-info', scene.url);
        if (!object(info) || !object(byUrl) || info.uuid !== scene.uuid || info.url !== scene.url || byUrl.uuid !== scene.uuid || info.importer !== 'scene') issues.push({ code: 'SCENE_IDENTITY_MISMATCH', path: `scenes[${i}]` });
    }
    if (typeof options.startScene !== 'string' || !identities.has(options.startScene)) issues.push({ code: 'START_SCENE_NOT_INCLUDED', path: 'startScene' });
    const bundles: unknown = await Editor.Message.request('builder', 'query-bundle-config' as never);
    if (!object(bundles) || !object(bundles[String(platform)]) || !Array.isArray((bundles[String(platform)] as Options).supportedCompressionTypes)) throw new ToolError({ code: 'BUILD_PREFLIGHT_UNAVAILABLE', status: 502, message: 'Creator returned no target bundle requirements.' });
    const compression = (bundles[String(platform)] as Options).supportedCompressionTypes as unknown[];
    if (options.mainBundleCompressionType !== undefined && !compression.includes(options.mainBundleCompressionType)) issues.push({ code: 'UNSUPPORTED_BUNDLE_COMPRESSION', path: 'mainBundleCompressionType' });
    const remote = options.mainBundleIsRemote === true;
    const server = options.remoteServerAddress ?? options.server;
    if (remote && options.useBuiltinServer !== true) {
        try { const url = new URL(String(server)); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { issues.push({ code: 'REMOTE_SERVER_REQUIRED', path: 'remoteServerAddress' }); }
    }
    return { valid: issues.length === 0, complete: true, targetAvailable, sceneCount: identities.size, issues, writes: false, toolchainVerified: false, signingVerified: false };
}
export async function inspectBuildEnvironment() {
    const programs: Record<string, { available: boolean; configured: boolean; pathRedacted: true }> = {};
    for (const name of ['androidSDK', 'androidNDK', 'java']) {
        const info: unknown = await Editor.Message.request('program', 'query-program-info', name);
        if (info != null && !object(info)) throw new ToolError({ code: 'BUILD_ENVIRONMENT_INVALID_RESPONSE', status: 502, message: 'Creator returned invalid program metadata.' });
        programs[name] = { available: object(info), configured: object(info) && typeof info.path === 'string' && info.path.trim().length > 0, pathRedacted: true };
    }
    return { programs, writes: false, toolchainVerified: false, signingVerified: false, javaInspection: programs.java.available ? 'registered-program' : 'unavailable-editor-api' };
}
