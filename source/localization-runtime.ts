import { pathToFileURL } from 'url';

export interface LocalizationRuntime {
    currentLanguage?: unknown;
    languages?: unknown;
    direction(language: string): unknown;
    exists(key: string): unknown;
}

/** Resolve the official mounted script through Asset DB, then its Creator compiler loader. */
export async function loadLocalizationRuntime(): Promise<LocalizationRuntime> {
    const asset: unknown = await Editor.Message.request('asset-db', 'query-asset-info', 'db://localization-editor/l10n.ts');
    if (!asset || typeof asset !== 'object' || !('file' in asset) || typeof asset.file !== 'string' || !asset.file
        || !('uuid' in asset) || typeof asset.uuid !== 'string' || !asset.uuid || !('url' in asset) || asset.url !== 'db://localization-editor/l10n.ts') {
        throw new Error('Official localization-editor runtime asset is not mounted or its identity is unavailable.');
    }
    const file = asset.file;
    const uuid = asset.uuid;
    const root: unknown = globalThis;
    if (!root || typeof root !== 'object' || !('System' in root)) throw new Error('Creator SystemJS loader is unavailable.');
    const loader = root.System;
    if (!loader || typeof loader !== 'object' || !('import' in loader) || typeof loader.import !== 'function') throw new Error('Creator SystemJS import is unavailable.');
    const moduleValue: unknown = await loader.import(pathToFileURL(file).href);
    const current: unknown = await Editor.Message.request('asset-db', 'query-asset-info', 'db://localization-editor/l10n.ts');
    if (!current || typeof current !== 'object' || !('file' in current) || current.file !== file
        || !('uuid' in current) || current.uuid !== uuid || !('url' in current) || current.url !== 'db://localization-editor/l10n.ts') {
        throw new Error('Official localization runtime asset identity changed during import.');
    }
    if (!moduleValue || typeof moduleValue !== 'object' || !('l10n' in moduleValue)) throw new Error('Localization module does not export l10n.');
    const runtime = moduleValue.l10n;
    if (!runtime || typeof runtime !== 'object' || !('exists' in runtime) || typeof runtime.exists !== 'function'
        || !('direction' in runtime) || typeof runtime.direction !== 'function') throw new Error('Localization runtime contract is unavailable.');
    return runtime as LocalizationRuntime;
}
