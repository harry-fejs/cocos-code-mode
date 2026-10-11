type Entry = Record<string, unknown>;
const REDACTED = '[REDACTED]';
const SENSITIVE = /^(?:.*(?:password|passwd|passphrase|secret|token|credential|authorization|cookie|privatekey|apikey)|pwd|auth|sessionid)$/i;
const MAX_DETAIL_NODES = 20000;
const MAX_DETAIL_CHARS = 2 * 1024 * 1024;

/** A detached, redacted snapshot: never mutate tool arguments or invoke getters/toJSON. */
export function snapshotInteraction(entry: Entry): Entry {
    let nodes = 0;
    let chars = 0;
    let limited = false;
    const ancestors = new Set<object>();
    const omit = (reason: string): string => { limited = true; return `[truncated: ${reason}]`; };
    const visit = (value: unknown, depth: number): unknown => {
        if (++nodes > MAX_DETAIL_NODES || chars >= MAX_DETAIL_CHARS) return omit('detail budget');
        if (typeof value === 'string') {
            const available = Math.min(262144, MAX_DETAIL_CHARS - chars);
            chars += Math.min(value.length, available);
            return value.length > available ? value.slice(0, available) + omit('long string') : value;
        }
        if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value !== 'object') return String(value);
        if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            return omit(`binary payload, ${value.byteLength} bytes`);
        }
        if (ancestors.has(value)) return omit('circular reference');
        if (depth >= 32) return omit('detail depth');
        ancestors.add(value);
        const result: Entry | unknown[] = Array.isArray(value) ? [] : Object.create(null);
        try {
            for (const key in value) {
                if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                if (nodes >= MAX_DETAIL_NODES || chars >= MAX_DETAIL_CHARS) {
                    if (Array.isArray(result)) result.push(omit('remaining items'));
                    else result['[truncated]'] = omit('remaining fields');
                    break;
                }
                chars += key.length;
                // Huge keys cannot be copied without defeating the total detail bound.
                if (key.length > 4096) { (result as Entry)['[truncated key]'] = omit('long field name'); break; }
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (descriptor && 'value' in descriptor && descriptor.value === undefined) continue;
                const item = SENSITIVE.test(key.replace(/[^a-z0-9]/gi, ''))
                    ? REDACTED
                    : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : omit('accessor');
                Object.defineProperty(result, key, { value: item, enumerable: true, configurable: true, writable: true });
            }
        } catch {
            (result as Entry)['[unavailable]'] = omit('unreadable value');
        }
        ancestors.delete(value);
        return result;
    };
    const snapshot = visit(entry, 0) as Entry;
    if (limited) snapshot.detailTruncated = true;
    return snapshot;
}

function compact(value: unknown, max = 96): string {
    const string = String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ').trim();
    return string.length > max ? `${string.slice(0, max - 1)}…` : string;
}

function nested(value: unknown, key: string): unknown {
    return value && typeof value === 'object' ? (value as Entry)[key] : undefined;
}

function quoted(value: unknown): string {
    return `“${compact(value, 72)}”`;
}

export function formatInteractionHeadline(entry: Entry): string {
    const tool = compact(entry.tool, 80) || 'unknown tool';
    const phase = entry.phase === 'start' ? 'REQUEST' : entry.phase === 'complete' ? 'SUCCESS' : entry.phase === 'error' ? 'FAILED' : 'WARNING';
    const args = entry.args;
    const result = entry.result;
    let summary = phase === 'REQUEST' ? 'call' : phase === 'FAILED' ? compact(entry.code, 48) || compact(entry.message, 96) || 'request failed' : 'completed';
    if (tool === 'editorHandshake') {
        summary = phase === 'REQUEST' ? 'connectivity check' : (() => {
            const probe = nested(result, 'probe');
            const status = compact(nested(probe, 'status'), 32) || 'unknown';
            return status === 'responsive' && nested(result, 'projectMatches') === false ? 'responsive · project mismatch' : status === 'responsive' ? 'responsive' : `degraded · ${status}`;
        })();
    } else if (tool === 'editorPopupInspect') {
        const detected = nested(result, 'detected');
        summary = phase === 'REQUEST' ? 'inspect popup' : detected === true ? `${nested(result, 'blocking') === true ? 'blocking popup' : 'popup detected'}${typeof nested(result, 'total') === 'number' ? ` · ${nested(result, 'total')} windows` : ''}` : detected === false ? 'no popup' : 'inspection incomplete';
    } else if (tool === 'editorPopupAction') {
        const label = nested(args, 'actionLabel') ?? nested(result, 'actionLabel');
        summary = `${compact(nested(args, 'operation') ?? nested(result, 'operation') ?? 'popup action')}${label ? ` ${quoted(label)}` : ''}`;
        if (phase === 'SUCCESS') summary += nested(result, 'closed') === true ? ' · activated, closed' : nested(result, 'activated') === true ? ' · activated' : '';
    } else if (tool === 'nodeCreate') summary = phase === 'REQUEST' ? `create node ${quoted(nested(args, 'name'))}` : 'node created';
    else if (tool === 'nodeGetTree') {
        const reference = nested(args, 'reference');
        const target = nested(reference, 'id');
        const depth = nested(args, 'maxDepth');
        const nodes = nested(args, 'maxNodes');
        const params = [target ? `reference=${compact(target, 72)}` : null,
            depth === undefined ? null : `maxDepth=${compact(depth, 16)}`,
            nodes === undefined ? null : `maxNodes=${compact(nodes, 16)}`].filter(Boolean).join(' · ');
        summary = `${phase === 'REQUEST' ? 'read node tree' : `${quoted(nested(result, 'name') || nested(result, 'path'))} · ${compact(nested(result, 'childrenCount') ?? '?')} children`}${params ? ` · ${params}` : ''}`;
    }
    else if (tool === 'sceneGetInfo') summary = phase === 'REQUEST' ? 'read scene info' : `${compact(nested(result, 'nodeCount') ?? '?')} nodes · dirty=${compact(nested(result, 'dirty'))}`;
    else if (tool === 'assetResolvePath') summary = phase === 'REQUEST' ? `resolve asset ${quoted(nested(args, 'reference'))}` : nested(result, 'exists') === true ? `resolved · ${compact(nested(result, 'relativePath') || nested(result, 'url'), 72)}` : 'asset not found';
    else if (tool === 'assetQuery') summary = phase === 'REQUEST' ? `query assets${nested(args, 'extname') ? ` · ${compact(nested(args, 'extname'))}` : ''}` : `${compact(nested(result, 'total') ?? '?')} assets`;
    else if (tool === 'editorState') summary = phase === 'REQUEST' ? 'read editor state' : `scene ready=${compact(nested(nested(result, 'scene'), 'ready') ?? 'unknown')} · popup=${compact(nested(nested(result, 'popup'), 'detected') ?? 'unknown')}`;
    return `[cx3][api]${typeof entry.requestId === 'string' ? `[${compact(entry.requestId.slice(0, 8), 8)}]` : ''} ${phase} ${tool} · ${summary}${entry.status === undefined ? '' : ` ${compact(entry.status, 16)}`}${entry.durationMs === undefined ? '' : ` · ${compact(entry.durationMs, 16)}ms`}`;
}

/** Plain text display has independent, stricter limits than its JSONL snapshot. */
export function renderInteraction(entry: Entry, headline = formatInteractionHeadline(entry)): { text: string; truncated: boolean } {
    const lines: string[] = [];
    let chars = 0;
    let nodes = 0;
    let truncated = entry.detailTruncated === true;
    const add = (line: string): boolean => {
        if (lines.length >= 112 || chars + line.length + 1 > 14000) { truncated = true; return false; }
        lines.push(line);
        chars += line.length + 1;
        return true;
    };
    const text = (value: unknown, max = 256): string => {
        const string = String(value ?? '').replace(/[\r\n\t\u0000-\u001f\u007f]/g, ' ');
        if (string.length > max) { truncated = true; return string.slice(0, max) + ' [truncated]'; }
        return string;
    };
    const field = (label: string, value: unknown, depth = 0): void => {
        if (value === undefined) return;
        if (++nodes > 512 || lines.length >= 112 || chars >= 14000) { truncated = true; return; }
        const indent = '  '.repeat(depth);
        const key = text(label);
        if (value !== null && typeof value === 'object') {
            if (depth >= 8) { truncated = true; add(`${indent}${key}: [truncated: display depth]`); return; }
            const keys = Object.keys(value);
            if (!keys.length) { add(`${indent}${key}: ${Array.isArray(value) ? '(empty array)' : '(empty object)'}`); return; }
            if (!add(`${indent}${key}:`)) return;
            for (const child of keys) {
                if (nodes >= 512 || lines.length >= 112 || chars >= 14000) { truncated = true; break; }
                field(Array.isArray(value) ? `[${child}]` : child, (value as Entry)[child], depth + 1);
            }
        } else if (typeof value === 'string') {
            let string = value;
            if (string.length > 2000) { string = string.slice(0, 2000) + ' [truncated: long string]'; truncated = true; }
            if (/\r|\n/.test(string)) {
                if (!add(`${indent}${key}: |`)) return;
                for (const line of string.split(/\r\n|\r|\n/)) {
                    if (!add(`${indent}  ${line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')}`)) break;
                }
            } else add(`${indent}${key}: ${string === '' ? '""' : string.replace(/[\u0000-\u001f\u007f]/g, ' ')}`);
        } else add(`${indent}${key}: ${String(value)}`);
    };
    add(headline + (entry.testId ? ` [test:${text(entry.testId)}]${entry.expectedTest ? ' expected' : ''}` : ''));
    if (entry.phase === 'start') {
        field('Params', entry.args);
    } else if (entry.phase === 'complete') {
        if (entry.tool === 'nodeGetTree') field('Params', entry.args);
        field('Result', entry.result);
    } else {
        field('Code', entry.code);
        field('Message', entry.message);
        field('Params', entry.args);
        field('Details', entry.details);
        field('Recovery', entry.recovery);
        field('Stack', entry.stack);
    }
    return { text: lines.join('\n'), truncated };
}
