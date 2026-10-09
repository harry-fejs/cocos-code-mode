import { createHash } from 'crypto';
import { utcpTool } from '../decorators';
import { readElectronWindowSnapshot } from '../electron-window-snapshot';

const MAX_SCREENSHOT_DIMENSION = 4096;
const MAX_SCREENSHOT_PIXELS = MAX_SCREENSHOT_DIMENSION * MAX_SCREENSHOT_DIMENSION;

function validateScreenshotSize(imageSize: unknown): { width: number, height: number } {
    if (imageSize === undefined) return { width: 512, height: 512 };

    const dimensions = typeof imageSize === 'number'
        ? { width: imageSize, height: imageSize }
        : imageSize;
    if (!dimensions || typeof dimensions !== 'object') {
        throw new Error('captureSceneScreenshot imageSize must be a positive integer or { width, height }');
    }

    const candidate = dimensions as { width?: unknown, height?: unknown };
    const { width, height } = candidate;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        throw new Error('captureSceneScreenshot imageSize width and height must be positive integers');
    }
    if (width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION || width * height > MAX_SCREENSHOT_PIXELS) {
        throw new Error(`captureSceneScreenshot imageSize exceeds ${MAX_SCREENSHOT_DIMENSION}px per side or ${MAX_SCREENSHOT_PIXELS} pixels`);
    }
    return { width, height };
}

function validateJpegQuality(jpegQuality: unknown): number {
    if (jpegQuality === undefined) return 80;
    if (typeof jpegQuality !== 'number' || !Number.isInteger(jpegQuality) || jpegQuality < 0 || jpegQuality > 100) {
        throw new Error('captureSceneScreenshot jpegQuality must be an integer from 0 to 100');
    }
    return jpegQuality;
}

// Screenshot tools — capture scene canvas and editor windows.
// Scene capture reuses the existing captureScreenshot in scene.ts.
// Editor capture uses Electron BrowserWindow API (may not be available in all contexts).

export class ScreenshotTools {

    @utcpTool(
        'captureSceneScreenshot',
        'Capture the current scene view as a JPEG image. Uses the game canvas in edit mode.',
        {
            type: 'object',
            properties: {
                imageSize: {
                    oneOf: [
                        { type: 'integer', minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION, description: 'Square size (width=height)' },
                        {
                            type: 'object',
                            properties: {
                                width: { type: 'integer', minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION },
                                height: { type: 'integer', minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION },
                            },
                            required: ['width', 'height'],
                            description: `Exact dimensions; maximum ${MAX_SCREENSHOT_PIXELS} pixels`,
                        },
                    ],
                    description: `Image size (default 512; maximum ${MAX_SCREENSHOT_DIMENSION}px per side and ${MAX_SCREENSHOT_PIXELS} pixels)`,
                },
                jpegQuality: { type: 'integer', minimum: 0, maximum: 100, description: 'JPEG quality 0-100 (default 80)' },
            },
        },
        {
            type: 'object',
            properties: {
                type: { type: 'string' },
                data: { type: 'string', description: 'Base64-encoded JPEG data' },
                mimeType: { type: 'string' },
            },
            required: ['type', 'data', 'mimeType'],
        },
        'POST',
        ['screenshot', 'capture', 'scene', 'image', 'visual', 'verify']
    )
    async captureSceneScreenshot(args: { imageSize?: number | { width: number, height: number }, jpegQuality?: number }): Promise<{ type: string, data: string, mimeType: string }> {
        const imageSize = validateScreenshotSize(args.imageSize);
        const jpegQuality = validateJpegQuality(args.jpegQuality);

        const base64 = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x',
            method: 'captureScreenshot',
            args: [imageSize, jpegQuality],
        }) as string;

        // JPEG base64 always begins /9j/. Anything else (notably "data:," from a
        // zero-sized canvas) is a failed capture masquerading as an image — the
        // docs §1 canonical silent failure. Plain Error: ambiguous engine output.
        if (typeof base64 !== 'string' || !base64.startsWith('/9j/')) {
            throw new Error(`Scene capture returned no image data (got ${JSON.stringify(String(base64).slice(0, 32))}). The scene view may not be rendering.`);
        }

        return { type: 'image', data: base64, mimeType: 'image/jpeg' };
    }

    @utcpTool(
        'captureEditorScreenshot',
        'Capture the focused editor window as a PNG image. Requires Electron BrowserWindow API.',
        {
            type: 'object',
            properties: {
                windowTitle: { type: 'string', description: 'Optional window title substring to match' },
            },
        },
        {
            type: 'object',
            properties: {
                type: { type: 'string' },
                data: { type: 'string', description: 'Base64-encoded PNG data' },
                mimeType: { type: 'string' },
            },
            required: ['type', 'data', 'mimeType'],
        },
        'POST',
        ['screenshot', 'capture', 'editor', 'window', 'image', 'visual']
    )
    async captureEditorScreenshot(args: { windowTitle?: string }): Promise<{ type: string, data: string, mimeType: string }> {
        let BrowserWindow: any;
        try {
            const electron = require('electron');
            BrowserWindow = electron.BrowserWindow;
        } catch (e: any) {
            throw new Error(`Electron BrowserWindow not available: ${e.message}`);
        }

        if (!BrowserWindow) {
            throw new Error('BrowserWindow API not available in this context');
        }

        let targetWindow: any = null;
        if (args.windowTitle) {
            const allWindows = BrowserWindow.getAllWindows();
            targetWindow = allWindows.find((w: any) => w.getTitle().includes(args.windowTitle));
        }
        if (!targetWindow) {
            targetWindow = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
        }

        if (!targetWindow) {
            throw new Error('No editor window found');
        }

        try {
            const image = await targetWindow.capturePage();
            if (image.isEmpty()) throw new Error('Editor window capture produced an empty image');
            const buffer = image.toPNG();
            if (!buffer.length) throw new Error('Editor window capture produced no PNG bytes');
            const base64 = buffer.toString('base64');
            // PNG base64 always begins iVBORw0KGgo
            if (!base64.startsWith('iVBORw0KGgo')) throw new Error(`Editor window capture produced invalid PNG (got ${JSON.stringify(base64.slice(0, 16))})`);
            return { type: 'image', data: base64, mimeType: 'image/png' };
        } catch (e: any) {
            throw new Error(`Failed to capture editor window: ${e.message}`);
        }
    }

    @utcpTool(
        'editorPanelCapture',
        'Capture one named editor panel using explicit bounded coordinates and validate the PNG result.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                panelTitle: { type: 'string', minLength: 1, maxLength: 128 },
                bounds: {
                    type: 'object',
                    properties: {
                        x: { type: 'integer', minimum: 0 },
                        y: { type: 'integer', minimum: 0 },
                        width: { type: 'integer', minimum: 1, maximum: 4096 },
                        height: { type: 'integer', minimum: 1, maximum: 4096 },
                    },
                    required: ['x', 'y', 'width', 'height'],
                },
            },
            required: ['panelTitle', 'bounds'],
        },
        {
            type: 'object',
            properties: {
                panelTitle: { type: 'string' },
                bounds: { type: 'object' },
                type: { type: 'string' },
                data: { type: 'string' },
                mimeType: { type: 'string' },
            },
            required: ['panelTitle', 'bounds', 'type', 'data', 'mimeType'],
        },
        'POST',
        ['screenshot', 'capture', 'editor', 'panel', 'image', 'visual'],
    )
    async editorPanelCapture(args: { panelTitle: string, bounds: { x: number, y: number, width: number, height: number } }): Promise<{ panelTitle: string, bounds: typeof args.bounds, type: string, data: string, mimeType: string }> {
        if (!args.panelTitle.trim()) throw new Error('editorPanelCapture requires panelTitle');
        const { x, y, width, height } = args.bounds;
        if (![x, y, width, height].every(Number.isInteger) || x < 0 || y < 0 || width < 1 || height < 1 || width > MAX_SCREENSHOT_DIMENSION || height > MAX_SCREENSHOT_DIMENSION) {
            throw new Error('editorPanelCapture bounds must be non-negative integer coordinates and bounded positive dimensions');
        }
        let BrowserWindow: any;
        try { BrowserWindow = require('electron').BrowserWindow; } catch (e: any) { throw new Error(`Electron BrowserWindow not available: ${e.message}`); }
        const targetWindow = BrowserWindow?.getAllWindows().find((window: any) => window.getTitle().includes(args.panelTitle));
        if (!targetWindow) throw new Error(`Editor panel window not found: ${args.panelTitle}`);
        const image = await targetWindow.capturePage({ x, y, width, height });
        if (image.isEmpty()) throw new Error('Editor panel capture produced an empty image');
        const data = image.toPNG().toString('base64');
        if (!data.startsWith('iVBORw0KGgo')) throw new Error('Editor panel capture produced invalid PNG data');
        return { panelTitle: args.panelTitle, bounds: args.bounds, type: 'image', data, mimeType: 'image/png' };
    }

    @utcpTool(
        'runtimeScreenshotAssert',
        'Capture one bounded editor target and assert PNG identity plus optional expected SHA-256.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                windowTitle: { type: 'string', minLength: 1, maxLength: 128 },
                bounds: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        x: { type: 'integer', minimum: 0 },
                        y: { type: 'integer', minimum: 0 },
                        width: { type: 'integer', minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION },
                        height: { type: 'integer', minimum: 1, maximum: MAX_SCREENSHOT_DIMENSION },
                    },
                    required: ['x', 'y', 'width', 'height'],
                },
                expectedSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
            },
            required: ['windowTitle', 'bounds'],
        },
        {
            type: 'object',
            properties: {
                windowTitle: { type: 'string' }, bounds: { type: 'object' }, sha256: { type: 'string' },
                bytes: { type: 'integer' }, signatureValid: { type: 'boolean' }, matched: { type: 'boolean' },
                passed: { type: 'boolean' }, diagnostics: { type: 'array' },
            },
            required: ['windowTitle', 'bounds', 'sha256', 'bytes', 'signatureValid', 'matched', 'passed', 'diagnostics'],
        },
        'POST',
        ['runtime', 'screenshot', 'assert', 'editor', 'visual'],
    )
    async runtimeScreenshotAssert(args: { windowTitle: string, bounds: { x: number, y: number, width: number, height: number }, expectedSha256?: string }): Promise<{ windowTitle: string, bounds: typeof args.bounds, sha256: string, bytes: number, signatureValid: boolean, matched: boolean, passed: boolean, diagnostics: string[] }> {
        let capture: { panelTitle: string, bounds: typeof args.bounds, type: string, data: string, mimeType: string };
        try {
            capture = await this.editorPanelCapture({ panelTitle: args.windowTitle, bounds: args.bounds });
        } catch {
            const full = await this.captureEditorScreenshot({ windowTitle: args.windowTitle });
            capture = { panelTitle: args.windowTitle, bounds: args.bounds, ...full };
        }
        const buffer = Buffer.from(capture.data, 'base64');
        const signatureValid = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const matched = args.expectedSha256 === undefined || sha256 === args.expectedSha256;
        const diagnostics: string[] = [];
        if (!signatureValid) diagnostics.push('PNG_SIGNATURE_INVALID');
        if (!matched) diagnostics.push('SHA256_MISMATCH');
        return { windowTitle: args.windowTitle, bounds: args.bounds, sha256, bytes: buffer.length, signatureValid, matched, passed: signatureValid && matched, diagnostics };
    }

    @utcpTool(
        'listEditorWindows',
        'List available Electron windows for screenshot or input targeting.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                windows: { type: 'array', items: { type: 'object' } },
            },
            required: ['windows'],
        },
        'GET',
        ['window', 'list', 'editor', 'electron', 'screenshot', 'target']
    )
    async listEditorWindows(): Promise<{ windows: Array<{ id: number, title: string, focused: boolean }> }> {
        const snapshot = readElectronWindowSnapshot();
        return {
            windows: snapshot.windows
                .filter(window => window.numericId !== null)
                .map(window => ({ id: window.numericId!, title: window.title, focused: window.focused === true })),
        };
    }
}
