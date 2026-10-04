import * as path from 'path';
import { performance } from 'perf_hooks';
import { getBuildInfo } from '../../build-info';
import { utcpTool } from '../decorators';
import { controlNumber, controlObject, controlText, invalidControl } from '../editor-control-validation';
import { beginEditorMessageProbe } from '../editor-state';

interface HandshakeArgs { timeoutMs?: number; expectedProjectPath?: string }
type Probe = { status: 'responsive' | 'timeout' | 'error' | 'invalid-response'; sceneReady: boolean | null; code: string | null };
const nullableText = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };

function normalizedProject(value: string): string {
    const normalized = path.normalize(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export class EditorHandshakeTools {
    constructor(private readonly instanceId: string) {}

    @utcpTool('editorHandshake', 'Read-only connectivity handshake. Returns bridge instance/build and project identity, plus a bounded scene IPC probe. sceneReady:false still means responsive; null means unverified. Compare expectedProjectPath before mutations. Always exposed in every profile. Transport/registration failures must be handled by the client. No panels, scene changes or background heartbeat.', {
        type: 'object', additionalProperties: false,
        properties: {
            timeoutMs: { type: 'integer', minimum: 1, maximum: 5000, description: 'IPC deadline in ms; default 1000.' },
            expectedProjectPath: { type: 'string', minLength: 1, maxLength: 4096, description: 'Absolute project path; lexical normalization, case-insensitive on Windows; no symlink resolution.' },
        },
    }, {
        type: 'object',
        properties: {
            instanceId: { type: 'string' }, projectPath: nullableText, editorVersion: nullableText,
            projectMatches: nullableBoolean,
            build: { type: 'object', properties: { version: { type: 'string' }, commit: { type: 'string' }, branch: { type: 'string' }, dirty: { type: 'boolean' }, builtAt: { type: 'string' }, mode: { type: 'string', enum: ['readable', 'debug-minified', 'unknown'] } }, required: ['version', 'commit', 'branch', 'dirty', 'builtAt', 'mode'] },
            probe: { type: 'object', properties: { status: { type: 'string', enum: ['responsive', 'timeout', 'error', 'invalid-response'] }, sceneReady: nullableBoolean, code: nullableText,
                evidence: { type: 'object', properties: { requestId: { type: 'string' }, startedAt: { type: 'integer' }, ageMs: { type: 'integer' }, shared: { type: 'boolean' }, settled: { type: 'boolean' } }, required: ['requestId', 'startedAt', 'ageMs', 'shared', 'settled'] },
            }, required: ['status', 'sceneReady', 'code', 'evidence'] },
            capturedAt: { type: 'integer' }, elapsedMs: { type: 'integer' },
        },
        required: ['instanceId', 'projectPath', 'editorVersion', 'projectMatches', 'build', 'probe', 'capturedAt', 'elapsedMs'],
    }, 'GET', ['editor', 'handshake', 'connection', 'health'], { profile: 'core', logGroup: 'protocol' })
    async editorHandshake(input: HandshakeArgs = {}) {
        const args = controlObject(input, ['timeoutMs', 'expectedProjectPath']);
        const timeoutMs = args.timeoutMs === undefined ? 1000 : controlNumber(args.timeoutMs, 'timeoutMs', 1, 5000);
        const expected = args.expectedProjectPath === undefined ? null : controlText(args.expectedProjectPath, 'expectedProjectPath', 4096, true);
        if (expected !== null && !path.isAbsolute(expected)) invalidControl('expectedProjectPath must be absolute.');
        const started = performance.now();
        const projectPath = typeof Editor.Project?.path === 'string' ? Editor.Project.path : null;
        const editorVersion = typeof Editor.App?.version === 'string' ? Editor.App.version : null;
        let timer: NodeJS.Timeout | undefined;
        const ipc = beginEditorMessageProbe('scene', 'query-is-ready');
        const request = ipc.promise.then((ready): Probe => {
            if (typeof ready !== 'boolean') return { status: 'invalid-response', sceneReady: null, code: 'INVALID_EDITOR_RESPONSE' };
            return { status: 'responsive', sceneReady: ready, code: null };
        }, (error): Probe => error?.code === 'EDITOR_IPC_TIMEOUT'
            ? { status: 'timeout', sceneReady: null, code: 'EDITOR_IPC_TIMEOUT' }
            : { status: 'error', sceneReady: null, code: 'EDITOR_IPC_ERROR' });
        let probe: Probe;
        try {
            probe = await Promise.race([request, new Promise<Probe>(resolve => {
                timer = setTimeout(() => resolve({ status: 'timeout', sceneReady: null, code: 'EDITOR_IPC_TIMEOUT' }), timeoutMs);
            })]);
        } finally { clearTimeout(timer); }
        return {
            instanceId: this.instanceId, projectPath, editorVersion,
            projectMatches: expected === null || projectPath === null ? null : normalizedProject(expected) === normalizedProject(projectPath),
            build: getBuildInfo(), probe: { ...probe, evidence: ipc.evidence() }, capturedAt: Date.now(), elapsedMs: Math.round(performance.now() - started),
        };
    }
}
