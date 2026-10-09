// Response envelope + auto-refs. When enabled, every tool response is wrapped
// in a standard envelope with callId/summary/refs for faster agent follow-up.
// Opt-in via profile config (toolProfile:envelope); default OFF for backward compat.

import crypto from 'crypto';

interface RefEntry {
    type: string;
    id: string;
    path?: string;
    name?: string;
}

interface ResultEnvelope {
    ok: boolean;
    tool: string;
    callId: string;
    timestamp: string;
    summary: string;
    data: any;
    refs: RefEntry[];
}

function hashObject(value: any): string {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function summarizeResult(result: any): string {
    if (typeof result === 'string') {
        if (result.startsWith('data:image/')) return 'Image payload returned.';
        return result.length > 160 ? `${result.slice(0, 160)}...` : result;
    }
    if (!result || typeof result !== 'object') return String(result);
    if (typeof result.summary === 'string') return result.summary;
    for (const key of ['message', 'path', 'url', 'sceneName', 'projectName']) {
        if (typeof result[key] === 'string' && result[key]) return `${key}: ${result[key]}`;
    }
    if (Number.isFinite(result.count)) return `count: ${result.count}`;
    return 'Structured result returned.';
}

function addRef(refs: RefEntry[], seen: Set<string>, entry: RefEntry): void {
    const key = `${entry.type}:${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(entry);
}

function collectRefs(
    value: any,
    refs: RefEntry[] = [],
    seen = new Set<string>(),
    depth = 0,
    weakSeen = new WeakSet(),
): RefEntry[] {
    if (!value || depth > 5) return refs;
    if (Array.isArray(value)) {
        for (const item of value) collectRefs(item, refs, seen, depth + 1, weakSeen);
        return refs;
    }
    if (typeof value !== 'object') return refs;
    if (weakSeen.has(value)) return refs;
    weakSeen.add(value);

    const uuid = value.uuid || value.prefabUuid || value.sceneUuid || value.assetUuid || (value.reference && value.reference.id);
    const pathValue = value.path || value.node || value.url;
    const typeField = value.type || value.componentType || value.assetType;

    if (uuid) {
        addRef(refs, seen, {
            type: pathValue && String(pathValue).startsWith('db://') ? 'asset' : 'uuid',
            id: String(uuid),
            path: pathValue ? String(pathValue) : undefined,
            name: value.name ? String(value.name) : undefined,
        });
    }
    if (typeof pathValue === 'string' && pathValue) {
        const exists = refs.some(r => r.path === pathValue);
        if (!exists) {
            addRef(refs, seen, {
                type: pathValue.startsWith('db://') ? 'asset' : 'path',
                id: String(pathValue),
                path: String(pathValue),
                name: value.name ? String(value.name) : undefined,
            });
        }
    }
    // Also catch reference objects directly
    if (value.reference && typeof value.reference === 'object' && value.reference.id) {
        addRef(refs, seen, {
            type: value.reference.type || 'reference',
            id: String(value.reference.id),
            name: value.name ? String(value.name) : undefined,
        });
    }

    for (const item of Object.values(value)) {
        collectRefs(item, refs, seen, depth + 1, weakSeen);
    }
    return refs;
}

export function createResultEnvelope(toolName: string, args: any, result: any, opts: { ok?: boolean; summary?: string } = {}): ResultEnvelope {
    const refs = collectRefs(result);
    const timestamp = new Date().toISOString();
    const summary = opts.summary || summarizeResult(result);
    const callId = `ccp_${hashObject({ tool: toolName, args: args || {}, result })}`;
    return {
        ok: opts.ok !== false,
        tool: toolName,
        callId,
        timestamp,
        summary,
        data: result,
        refs,
    };
}
