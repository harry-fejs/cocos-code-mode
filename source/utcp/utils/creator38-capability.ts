import { ToolError } from '../tool-error';

type CreatorApp = { version?: unknown };
type CreatorGlobal = typeof globalThis & { Editor?: { App?: CreatorApp } };

/** Bound version-specific editor seams; version alone is not qualification evidence. */
export function creatorVersion(): string | null {
    const editor = (globalThis as CreatorGlobal).Editor;
    const version = editor?.App?.version;
    return typeof version === 'string' && version ? version : null;
}

export function requireCreator38(route: string): void {
    const version = creatorVersion();
    if (version !== '3.8.8') {
        throw new ToolError({
            code: 'UNSUPPORTED_EDITOR_VERSION',
            status: 422,
            message: `${route} requires the bounded Creator3.8.8 API seam; the active editor version is ${version ?? 'unknown'}.`,
            details: { route, requiredVersion: '3.8.8', activeVersion: version },
            recovery: 'Bind the tool to an exact Creator3.8.8 editor and re-run the handshake before mutation.',
        });
    }
}

export function unsupportedCreator38(route: string, message: string, details?: Record<string, unknown>): never {
    throw new ToolError({
        code: 'UNSUPPORTED_EDITOR_API',
        status: 422,
        message,
        details: { route, requiredVersion: '3.8.8', activeVersion: creatorVersion(), ...details },
        recovery: 'Use the documented Creator3.8 API seam or leave the fixture unchanged; no filesystem fallback is available.',
    });
}
