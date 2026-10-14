import { ToolError } from './tool-error';

/** Official editor defaults only; runtime options may override fallback behavior. */
export async function inspectLocalizationResources() {
    const raw: unknown = await Editor.Message.request('localization-editor', 'get-resource-list');
    if (raw === undefined || raw === null) throw new ToolError({ code: 'LOCALIZATION_RESOURCE_UNAVAILABLE', status: 422, message: 'Official localization resource list is unavailable; configure the package local language.' });
    const tag = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Official package resource list is malformed.' });
    const data = raw as Record<string, unknown>;
    if (!Array.isArray(data.languages) || data.languages.length > 64 || data.languages.some(language => !tag(language)) || new Set(data.languages).size !== data.languages.length
        || !tag(data.defaultLanguage) || !tag(data.fallbackLanguage)) throw new ToolError({ code: 'LOCALIZATION_INVALID_RESPONSE', status: 502, message: 'Official resource language/default/fallback metadata is invalid or exceeds bounds.' });
    const languages = data.languages as string[];
    const issues: Array<{ code: string; locale: string }> = [];
    if (!languages.includes(data.defaultLanguage)) issues.push({ code: 'DEFAULT_LANGUAGE_NOT_INCLUDED', locale: data.defaultLanguage });
    if (!languages.includes(data.fallbackLanguage)) issues.push({ code: 'FALLBACK_LANGUAGE_NOT_INCLUDED', locale: data.fallbackLanguage });
    return { languages, defaultLanguage: data.defaultLanguage, fallbackLanguage: data.fallbackLanguage, issues, writes: false as const, runtimeVerified: false as const,
        verificationScope: 'Official editor resource-list metadata only. Runtime init options, localStorage, per-key fallback resolution, build inclusion, glyphs/layout and language-switch restart are not verified.' };
}
