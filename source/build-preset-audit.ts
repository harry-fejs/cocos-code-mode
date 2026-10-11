export const BUILD_PRESET_PLATFORMS = ['web-mobile', 'web-desktop', 'android', 'ios', 'windows', 'mac'] as const;
export type BuildPresetPlatform = typeof BUILD_PRESET_PLATFORMS[number];

export type BuildPresetIssueCode =
    | 'UNKNOWN_PLATFORM'
    | 'INVALID_OPTIONS'
    | 'MISSING_REQUIRED_OPTION'
    | 'INVALID_OPTION'
    | 'UNSUPPORTED_OPTION'
    | 'UNKNOWN_OPTION'
    | 'OPTIONS_TRUNCATED';

export interface BuildPresetIssue {
    code: BuildPresetIssueCode;
    path?: string;
    value?: unknown;
    message: string;
}

export interface BuildPresetAuditResult {
    platform: string;
    supportedOptions: string[];
    unsupportedOptions: string[];
    unknownOptions: string[];
    errors: BuildPresetIssue[];
    warnings: BuildPresetIssue[];
    valid: boolean;
    complete: boolean;
}

interface OptionRule {
    type: 'string' | 'boolean' | 'number' | 'array' | 'object' | 'sourceMaps' | 'stringOrObject' | 'objectOrArray';
    enum?: readonly string[];
    min?: number;
    max?: number;
    required?: boolean;
    items?: OptionRule;
    shape?: Record<string, OptionRule>;
}

const COMMON_RULES: Record<string, OptionRule> = {
    taskName: { type: 'string', max: 128 },
    taskId: { type: 'string', max: 256 },
    useSplashScreen: { type: 'boolean' },
    packAutoAtlas: { type: 'boolean' },
    name: { type: 'string', max: 128 },
    outputName: { type: 'string', max: 128 },
    buildPath: { type: 'string', max: 512 },
    logDest: { type: 'string', max: 512 },
    configPath: { type: 'string', max: 512 },
    startScene: { type: 'string', max: 512 },
    scenes: { type: 'array', max: 512 },
    debug: { type: 'boolean' },
    sourceMaps: { type: 'sourceMaps' },
    md5Cache: { type: 'boolean' },
    inlineSpriteFrames: { type: 'boolean' },
    inlineEnum: { type: 'boolean' },
    mangleProperties: { type: 'boolean' },
    skipCompressTexture: { type: 'boolean' },
    bundleCommonChunk: { type: 'boolean' },
    experimentalEraseModules: { type: 'boolean' },
    mainBundleCompressionType: { type: 'string', enum: ['none', 'merge_dep', 'merge_all_json', 'subpackage', 'zip'] },
    mainBundleIsRemote: { type: 'boolean' },
    useBuiltinServer: { type: 'boolean' },
    remoteServerAddress: { type: 'string', max: 2048 },
    startSceneAssetBundle: { type: 'boolean' },
    moveRemoteBundleScript: { type: 'boolean' },
    buildMode: { type: 'string', enum: ['normal', 'bundle', 'script'] },
    buildBundleOnly: { type: 'boolean' },
    useBuildAssetCache: { type: 'boolean' },
    useBuildEngineCache: { type: 'boolean' },
    useBuildTextureCompressCache: { type: 'boolean' },
    useBuildAutoAtlasCache: { type: 'boolean' },
    nativeCodeBundleMode: { type: 'string', enum: ['wasm', 'asmjs', 'both'] },
    wasmCompressionMode: { type: 'string', enum: ['brotli'] },
    packages: { type: 'stringOrObject' },
    polyfills: { type: 'object', shape: { asyncFunctions: { type: 'boolean' }, coreJs: { type: 'boolean' }, targets: { type: 'string', max: 256 } } },
    includeModules: { type: 'array', max: 256, items: { type: 'string', max: 256 } },
    includedModules: { type: 'array', max: 256, items: { type: 'string', max: 256 } },
    replaceSplashScreen: { type: 'boolean' },
};

const PLATFORM_RULES: Record<BuildPresetPlatform, Record<string, OptionRule>> = {
    'web-mobile': {
        'web-mobile': { type: 'array', max: 0 },
        orientation: { type: 'string', enum: ['auto', 'landscape', 'portrait'] },
        embedWebDebugger: { type: 'boolean' },
        remoteServerAddress: { type: 'string', max: 2048 },
    },
    'web-desktop': {
        useWebGPU: { type: 'boolean' },
        remoteServerAddress: { type: 'string', max: 2048 },
        resolution: { type: 'object', shape: { designWidth: { type: 'number', min: 1 }, designHeight: { type: 'number', min: 1 } } },
    },
    android: {
        packageName: { type: 'string', max: 256 },
        apiLevel: { type: 'number', min: 1 },
        appABIs: { type: 'array', max: 8, items: { type: 'string', enum: ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'] } },
        orientation: { type: 'object', shape: { landscapeRight: { type: 'boolean' }, landscapeLeft: { type: 'boolean' }, portrait: { type: 'boolean' }, upsideDown: { type: 'boolean' } } },
        useDebugKeystore: { type: 'boolean' },
        appBundle: { type: 'boolean' },
        androidInstant: { type: 'boolean' },
        inputSDK: { type: 'boolean' },
        remoteUrl: { type: 'string', max: 2048 },
        sdkPath: { type: 'string', max: 512 },
        ndkPath: { type: 'string', max: 512 },
        javaHome: { type: 'string', max: 512 },
        javaPath: { type: 'string', max: 512 },
        swappy: { type: 'boolean' },
        renderBackEnd: { type: 'object', shape: { vulkan: { type: 'boolean' }, gles3: { type: 'boolean' }, gles2: { type: 'boolean' } } },
    },
    ios: {
        executableName: { type: 'string', max: 256 },
        packageName: { type: 'string', max: 256 },
        orientation: { type: 'object', shape: { landscapeRight: { type: 'boolean' }, landscapeLeft: { type: 'boolean' }, portrait: { type: 'boolean' }, upsideDown: { type: 'boolean' } } },
        skipUpdateXcodeProject: { type: 'boolean' },
        renderBackEnd: { type: 'object', shape: { metal: { type: 'boolean' }, gles3: { type: 'boolean' }, gles2: { type: 'boolean' } } },
        osTarget: { type: 'object', shape: { iphoneos: { type: 'boolean' }, simulator: { type: 'boolean' } } },
        developerTeam: { type: 'string', max: 256 },
        targetVersion: { type: 'string', max: 64 },
    },
    windows: {
        executableName: { type: 'string', max: 256 },
        renderBackEnd: { type: 'object', shape: { vulkan: { type: 'boolean' }, gles3: { type: 'boolean' }, gles2: { type: 'boolean' } } },
        targetPlatform: { type: 'string', enum: ['x64'] },
        serverMode: { type: 'boolean' },
        vsData: { type: 'string', max: 512 },
    },
    mac: {
        executableName: { type: 'string', max: 256 },
        packageName: { type: 'string', max: 256 },
        renderBackEnd: { type: 'object', shape: { metal: { type: 'boolean' }, gles3: { type: 'boolean' }, gles2: { type: 'boolean' } } },
        supportM1: { type: 'boolean' },
        skipUpdateXcodeProject: { type: 'boolean' },
        targetVersion: { type: 'string', max: 64 },
    },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizedPlatform(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = value.trim().toLowerCase();
    return normalized.length > 64 ? `${normalized.slice(0, 61)}...` : normalized;
}
function boundedIssueValue(value: unknown): unknown {
    if (typeof value === 'string') return value.length > 256 ? `${value.slice(0, 253)}...` : value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (value && typeof value === 'object') return '[object]';
    return typeof value;
}
function matchesType(value: unknown, rule: OptionRule): boolean {
    if (rule.type === 'array') return Array.isArray(value);
    if (rule.type === 'object') return isPlainObject(value);
    if (rule.type === 'stringOrObject') return typeof value === 'string' || isPlainObject(value);
    if (rule.type === 'objectOrArray') return isPlainObject(value) || Array.isArray(value);
    if (rule.type === 'sourceMaps') return typeof value === 'boolean' || value === 'inline';
    return typeof value === rule.type;
}

function validateRule(path: string, value: unknown, rule: OptionRule): BuildPresetIssue | undefined {
    if (!matchesType(value, rule)) return { code: 'INVALID_OPTION', path, value: boundedIssueValue(value), message: `${path} must be a ${rule.type === 'sourceMaps' ? 'boolean or "inline"' : rule.type}.` };
    if (rule.type === 'sourceMaps' || rule.type === 'stringOrObject' || rule.type === 'objectOrArray') return undefined;
    if (rule.type === 'string' && typeof value === 'string') {
        if (value.length === 0) return { code: 'INVALID_OPTION', path, value: '', message: `${path} must not be empty.` };
        if (rule.max !== undefined && value.length > rule.max) return { code: 'INVALID_OPTION', path, value: boundedIssueValue(value), message: `${path} exceeds ${rule.max} characters.` };
        if (rule.enum && !rule.enum.includes(value)) return { code: 'INVALID_OPTION', path, value, message: `${path} must be one of: ${rule.enum.join(', ')}.` };
    }
    if (rule.type === 'number' && typeof value === 'number') {
        if (!Number.isFinite(value) || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max)) return { code: 'INVALID_OPTION', path, value: boundedIssueValue(value), message: `${path} is outside its supported numeric range.` };
    }
    if (rule.type === 'array' && Array.isArray(value)) {
        if (rule.max !== undefined && value.length > rule.max) return { code: 'INVALID_OPTION', path, value: value.length, message: `${path} contains more than ${rule.max} items.` };
        if (rule.items) for (let index = 0; index < value.length; index += 1) {
            const issue = validateRule(`${path}[${index}]`, value[index], rule.items);
            if (issue) return issue;
        }
    }
    return undefined;
}

function validateShape(path: string, value: Record<string, unknown>, shape: Record<string, OptionRule>): BuildPresetIssue[] {
    const issues: BuildPresetIssue[] = [];
    for (const key of Object.keys(value).slice(0, 32)) {
        const displayKey = key.length > 128 ? `${key.slice(0, 125)}...` : key;
        const rule = Object.prototype.hasOwnProperty.call(shape, key) ? shape[key] : undefined;
        if (!rule) {
            issues.push({ code: 'UNKNOWN_OPTION', path: `${path}.${displayKey}`, message: `${path}.${displayKey} is not recognized.` });
            continue;
        }
        const issue = validateRule(`${path}.${displayKey}`, value[key], rule);
        if (issue) issues.push(issue);
    }
    return issues;
}

const PLATFORM_OPTION_NAMES: Record<string, true> = {};
for (const rules of Object.values(PLATFORM_RULES)) {
    for (const key of Object.keys(rules)) PLATFORM_OPTION_NAMES[key] = true;
}


/** Pure, read-only validation against the public Creator 3.x build option contracts. */
export function buildBuildPresetAudit(platformInput: unknown, optionsInput: unknown): BuildPresetAuditResult {
    const platform = normalizedPlatform(platformInput);
    const errors: BuildPresetIssue[] = [];
    const warnings: BuildPresetIssue[] = [];
    const supportedOptions: string[] = [];
    const unsupportedOptions: string[] = [];
    const unknownOptions: string[] = [];
    const profile = (BUILD_PRESET_PLATFORMS as readonly string[]).includes(platform) ? PLATFORM_RULES[platform as BuildPresetPlatform] : undefined;

    if (!profile) {
        errors.push({ code: 'UNKNOWN_PLATFORM', path: 'platform', value: platform, message: `Unsupported build platform: ${platform || '(missing)'}.` });
        return { platform, supportedOptions, unsupportedOptions, unknownOptions, errors, warnings, valid: false, complete: false };
    }
    if (!isPlainObject(optionsInput)) {
        errors.push({ code: 'INVALID_OPTIONS', path: 'options', value: boundedIssueValue(optionsInput), message: 'options must be a plain object.' });
        return { platform, supportedOptions, unsupportedOptions, unknownOptions, errors, warnings, valid: false, complete: false };
    }

    const options = optionsInput;
    const keys = Object.keys(options);
    let complete = true;
    if (keys.length > 64) {
        errors.push({ code: 'OPTIONS_TRUNCATED', path: 'options', value: keys.length, message: 'options may contain at most 64 keys.' });
        complete = false;
    }
    const rules: Record<string, OptionRule> = { ...COMMON_RULES, ...profile };
    const globallyKnown = { ...COMMON_RULES, ...PLATFORM_OPTION_NAMES };
    for (const key of keys.slice(0, 64)) {
        const displayKey = key.length > 128 ? `${key.slice(0, 125)}...` : key;
        const hasRule = Object.prototype.hasOwnProperty.call(rules, key);
        if (!hasRule) {
            const knownForAnotherTarget = Object.prototype.hasOwnProperty.call(globallyKnown, key);
            if (knownForAnotherTarget) unsupportedOptions.push(displayKey);
            else unknownOptions.push(displayKey);
            const code = knownForAnotherTarget ? 'UNSUPPORTED_OPTION' : 'UNKNOWN_OPTION';
            errors.push({ code, path: `options.${displayKey}`, message: knownForAnotherTarget ? `${displayKey} is not supported for ${platform}.` : `${displayKey} is not a recognized build option.` });
            continue;
        }
        const rule = rules[key];
        supportedOptions.push(displayKey);
        const issue = validateRule(`options.${displayKey}`, options[key], rule);
        if (issue) errors.push(issue);
    }
    for (const [key, rule] of Object.entries(rules)) {
        if (rule.required && options[key] === undefined) errors.push({ code: 'MISSING_REQUIRED_OPTION', path: `options.${key}`, message: `${key} is required for ${platform}.` });
    }
    return { platform, supportedOptions, unsupportedOptions, unknownOptions, errors, warnings, valid: errors.length === 0, complete, };
}
