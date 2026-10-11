import packageJSON from '../package.json';

export interface IBuildInfo {
    version: string;
    commit: string;
    branch: string;
    dirty: boolean;
    builtAt: string;
    mode?: 'readable' | 'debug-minified' | 'unknown';
}

let cached: IBuildInfo | null = null;

/**
 * Build provenance, written by scripts/generate-build-info.js at build time.
 * A stale dist/ is byte-indistinguishable from a fresh one at a glance, which
 * once cost a whole test round: bugs were filed against a build that predated
 * the fixes. Surfaced in the startup log and in the /utcp manual so a client
 * can check what it is actually talking to.
 */
export function getBuildInfo(): IBuildInfo {
    if (cached) {
        return cached;
    }

    let stamped: Partial<IBuildInfo> = {};
    try {
        // Emitted next to the compiled output; absent if tsc ran on its own.
        stamped = require('./build-info.json');
    } catch (e) {
        // Leave the unknown defaults below.
    }

    cached = {
        version: packageJSON.version,
        commit: stamped.commit ?? 'unknown',
        branch: stamped.branch ?? 'unknown',
        dirty: stamped.dirty ?? false,
        builtAt: stamped.builtAt ?? 'unknown',
        mode: stamped.mode === 'readable' || stamped.mode === 'debug-minified' ? stamped.mode : 'unknown'
    };
    return cached;
}

/** One-line form for logs: "1.0.0 (35ec127-dirty on cc-3x7, built 2026-08-06T07:15:00Z)" */
export function formatBuildInfo(): string {
    const b = getBuildInfo();
    return `${b.version} (${b.commit}${b.dirty ? '-dirty' : ''} on ${b.branch}, built ${b.builtAt})`;
}
