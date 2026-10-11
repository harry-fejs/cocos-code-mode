import { ToolError } from '../tool-error';

export const PREFAB_RESPONSE_BYTES = 32768;
export function prefabResponseLimit(value?: number): number {
    const limit = value ?? PREFAB_RESPONSE_BYTES;
    if (!Number.isInteger(limit) || limit < 2048 || limit > 262144) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxBytes must be an integer from 2048 to 262144.' });
    return limit;
}
/** Bounds the entire serialized payload, not just the list count. Never slices identities or hashes. */
export function boundPrefabResponse(response: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
    const result: Record<string, unknown> = { ...response, responseTruncated: false, readBackTruncated: false };
    const bytes = () => Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes() <= maxBytes) return result;
    result.responseTruncated = true;
    const readBack = result.readBack;
    if (readBack && typeof readBack === 'object') {
        result.readBack = {};
        result.readBackTruncated = true;
        const summary: Record<string, unknown> = {};
        for (const key of ['uuid', 'name', 'active']) {
            if (key in readBack) {
                summary[key] = (readBack as Record<string, unknown>)[key];
                result.readBack = summary;
                if (bytes() > maxBytes) delete summary[key];
            }
        }
    }
    for (const key of ['sourceChanges', 'removedComponents', 'mountedComponents', 'mountedChildren', 'overrides']) {
        const values = result[key as keyof typeof result];
        if (!Array.isArray(values)) continue;
        const bounded = values.slice();
        (result as Record<string, unknown>)[key] = bounded;
        while (bounded.length && bytes() > maxBytes) bounded.pop();
        if (bounded.length !== values.length) {
            if (key === 'sourceChanges') (result as Record<string, unknown>).sourceDiffTruncated = true;
            else (result as Record<string, unknown>).truncated = true;
        }
    }
    if (bytes() > maxBytes) throw new ToolError({ code: 'PREFAB_RESPONSE_TOO_LARGE', status: 422, message: 'Required prefab response identity cannot fit maxBytes.', recovery: 'Increase maxBytes; after a mutation inspect the instance/source before any retry.' });
    return result;
}
