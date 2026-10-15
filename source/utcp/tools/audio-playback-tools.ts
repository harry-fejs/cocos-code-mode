import { JsonSchema } from '@utcp/sdk';
import { AudioPlaybackOperation, AudioPlaybackSuccess, createAudioPlaybackExecutor } from '../../audio-playback';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { executeGameViewOperation } from '../utils/game-view-transport';
import { RuntimeSessionTools } from './runtime-session-tools';

export interface AudioPlaybackObserveArgs { sessionId: string; nodeReference: { id: string } }
export interface AudioPlaybackControlArgs extends AudioPlaybackObserveArgs {
    operation: Exclude<AudioPlaybackOperation, 'observe'>;
    time?: number;
    timeoutMs?: number;
}
const targetProperties: Record<string, JsonSchema> = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] },
};
const stateSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        currentTime: { type: 'number', minimum: 0 }, duration: { type: 'number', minimum: 0 }, playing: { type: 'boolean' },
        playbackState: { type: 'string', enum: ['init', 'playing', 'paused', 'stopped', 'interrupted'] }, loaded: { type: 'boolean' },
        userActivation: { type: 'string', enum: ['active', 'inactive', 'unknown'] }, activationRequirement: { type: 'string', enum: ['unknown'] },
    }, required: ['currentTime', 'duration', 'playing', 'playbackState', 'loaded', 'userActivation', 'activationRequirement'],
};
const outputSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        success: { type: 'boolean', enum: [true] }, sessionId: { type: 'string' }, targetId: { type: 'string' }, nodeUuid: { type: 'string' },
        operation: { type: 'string', enum: ['play', 'pause', 'stop', 'seek', 'observe'] }, state: stateSchema,
        started: { type: 'boolean' }, ended: { type: 'boolean' },
    }, required: ['success', 'sessionId', 'targetId', 'nodeUuid', 'operation', 'state', 'started', 'ended'],
};

function validate(args: AudioPlaybackObserveArgs, operation: AudioPlaybackOperation, time?: number, timeoutMs?: number): void {
    const invalid = (message: string): never => { throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message }); };
    if (!args || typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 64) invalid('sessionId is required (1..64 characters).');
    if (!args.nodeReference || typeof args.nodeReference.id !== 'string' || !args.nodeReference.id.trim() || args.nodeReference.id.length > 256) invalid('nodeReference.id is required (1..256 characters).');
    if (!['play', 'pause', 'stop', 'seek', 'observe'].includes(operation)) invalid('Unknown audio operation.');
    if (operation === 'seek' ? !Number.isFinite(time) || time! < 0 : time !== undefined) invalid('Only seek accepts time, a finite nonnegative number of seconds.');
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000)) invalid('timeoutMs must be an integer from 100 to 5000.');
}

const findNodeSource = `(async function findRuntimeNode(id) {
    const scene = globalThis.cc?.director?.getScene?.();
    if (!scene || typeof id !== 'string') return null;
    const pending = [{ node: scene, depth: 0 }];
    const visited = new Set();
    let inspected = 0;
    while (pending.length && inspected < 20000) {
        const entry = pending.shift();
        const node = entry.node;
        if (!node || visited.has(node) || entry.depth > 2048) continue;
        visited.add(node);
        inspected++;
        if (node.uuid === id) return node;
        const children = node.children;
        if (!Array.isArray(children)) continue;
        for (const child of children) {
            if (child && !visited.has(child)) pending.push({ node: child, depth: entry.depth + 1 });
        }
    }
    return null;
})`;
const executorSource = createAudioPlaybackExecutor.toString();

function operationSource(request: { sessionId: string; targetId: string; nodeUuid: string; operation: AudioPlaybackOperation; time?: number; timeoutMs?: number }): string {
    const requestLiteral = JSON.stringify(request);
    return `(() => {
        const key = Symbol.for('ccp3x.audioPlaybackExecutor');
        let execute = globalThis[key];
        if (typeof execute !== 'function') {
            execute = (${executorSource})();
            globalThis[key] = execute;
        }
        return execute(${requestLiteral}, globalThis.cc, ${findNodeSource});
    })()`;
}

function throwRuntimeResult(result: unknown): asserts result is AudioPlaybackSuccess {
    if (result && typeof result === 'object' && (result as { success?: unknown }).success === true) return;
    const failure = result && typeof result === 'object' ? (result as { error?: Record<string, unknown> }).error : undefined;
    const code = typeof failure?.code === 'string' ? failure.code : 'AUDIO_OPERATION_FAILED';
    const status = typeof failure?.status === 'number' ? failure.status : 502;
    const message = typeof failure?.message === 'string' ? failure.message : 'Game View audio operation failed.';
    const details = failure && typeof failure.state === 'object' && failure.state !== null ? { state: failure.state, ...(failure.pendingMayComplete === true ? { pendingMayComplete: true } : {}) } : undefined;
    throw new ToolError({ code, status, message, details, recovery: failure?.pendingMayComplete === true ? 'Observe the bound audio source before retrying; the prior operation may still complete.' : undefined });
}

export class AudioPlaybackTools {
    @utcpTool('audioPlaybackControl', 'Control one validated AudioSource in the attached Creator 3.7.3 Game View and confirm actual playback state.', {
        type: 'object', additionalProperties: false,
        properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'stop', 'seek'] },
            time: { type: 'number', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 5000 } },
        required: ['sessionId', 'nodeReference', 'operation'],
    }, outputSchema, 'POST', ['audio', 'playback', 'runtime', 'control'])
    async audioPlaybackControl(args: AudioPlaybackControlArgs): Promise<AudioPlaybackSuccess> {
        if (!args || !['play', 'pause', 'stop', 'seek'].includes(args.operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Control requires play, pause, stop, or seek.' });
        return this.execute(args, args.operation, args.time, args.timeoutMs);
    }

    @utcpTool('audioPlaybackObserve', 'Observe one validated AudioSource in the attached Creator 3.7.3 Game View with truthful readback.', {
        type: 'object', additionalProperties: false, properties: targetProperties, required: ['sessionId', 'nodeReference'],
    }, outputSchema, 'POST', ['audio', 'playback', 'runtime', 'observe'])
    async audioPlaybackObserve(args: AudioPlaybackObserveArgs): Promise<AudioPlaybackSuccess> {
        return this.execute(args, 'observe');
    }

    @utcpTool('audioPlaybackWaitForState', 'Wait for observed AudioSource playing/loaded/time conditions in one attached Game View target. Read-only polling; stopped is not proof of natural completion. No playback dispatch or event listeners.', {
        type: 'object', additionalProperties: false,
        properties: { ...targetProperties, playing: { type: 'boolean' }, loaded: { type: 'boolean' }, minTime: { type: 'number', minimum: 0, maximum: 3600 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000 } },
        required: ['sessionId', 'nodeReference'],
    }, { type: 'object', additionalProperties: false, properties: { matched: { type: 'boolean', const: true }, observations: { type: 'integer' }, observation: outputSchema }, required: ['matched', 'observations', 'observation'] }, 'POST', ['audio', 'playback', 'wait', 'read-only'])
    async audioPlaybackWaitForState(args: AudioPlaybackObserveArgs & { playing?: boolean; loaded?: boolean; minTime?: number; timeoutMs?: number; pollMs?: number }) {
        validate(args, 'observe');
        const timeoutMs = args.timeoutMs ?? 3000;
        const pollMs = args.pollMs ?? 100;
        if (args.playing === undefined && args.loaded === undefined && args.minTime === undefined
            || args.playing !== undefined && typeof args.playing !== 'boolean'
            || args.loaded !== undefined && typeof args.loaded !== 'boolean'
            || args.minTime !== undefined && (typeof args.minTime !== 'number' || !Number.isFinite(args.minTime) || args.minTime < 0 || args.minTime > 3600)
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000
            || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide a bounded audio state condition, deadline and poll interval.' });
        const deadline = Date.now() + timeoutMs;
        let targetId: string | undefined;
        let observations = 0;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio observation deadline expired; no playback mutation dispatched.' });
            let timer: NodeJS.Timeout | undefined;
            let observation: AudioPlaybackSuccess;
            try {
                observation = await Promise.race([this.audioPlaybackObserve({ sessionId: args.sessionId, nodeReference: { id: args.nodeReference.id } }), new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio read exceeded the caller deadline; in-flight observation may still settle.' })), remaining);
                })]);
            } finally { clearTimeout(timer); }
            if (Date.now() >= deadline) throw new ToolError({ code: 'AUDIO_STATE_TIMEOUT', status: 409, message: 'Audio observation completed after the caller deadline.' });
            if (observation.success !== true || observation.operation !== 'observe' || observation.sessionId !== args.sessionId || observation.nodeUuid !== args.nodeReference.id
                || typeof observation.targetId !== 'string' || !observation.targetId) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio observation identity is invalid.' });
            if (targetId !== undefined && observation.targetId !== targetId) throw new ToolError({ code: 'RUNTIME_TARGET_CHANGED', status: 409, message: 'Audio target changed during state wait.' });
            targetId = observation.targetId;
            const state = observation.state;
            if (!state || typeof state.playing !== 'boolean' || typeof state.loaded !== 'boolean'
                || args.minTime !== undefined && (typeof state.currentTime !== 'number' || !Number.isFinite(state.currentTime) || state.currentTime < 0)) throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Audio wait received invalid state metrics.' });
            observations++;
            if ((args.playing === undefined || state.playing === args.playing) && (args.loaded === undefined || state.loaded === args.loaded)
                && (args.minTime === undefined || state.currentTime >= args.minTime)) return { matched: true as const, observations, observation };
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }

    private async execute(args: AudioPlaybackObserveArgs, operation: AudioPlaybackOperation, time?: number, timeoutMs?: number): Promise<AudioPlaybackSuccess> {
        validate(args, operation, time, timeoutMs);
        try {
            const inspected = await new RuntimeSessionTools().runtimeSessionLifecycle({ operation: 'inspect', sessionId: args.sessionId });
            const session = inspected.session;
            if (session && 'status' in session && session.status === 'stopped') throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: 'The runtime session is stopped.' });
            if (!inspected.success || !inspected.ready || !session || !('targetId' in session) || session.sessionId !== args.sessionId) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'The attached runtime session is not ready.' });
            if (session.targetKind !== 'game-view') throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_TRANSPORT', status: 422, message: 'Audio supports the Creator Game View transport only.' });
            const request = { sessionId: args.sessionId, targetId: session.targetId, nodeUuid: args.nodeReference.id, operation, ...(time === undefined ? {} : { time }), ...(timeoutMs === undefined ? {} : { timeoutMs }) };
            const transportTimeout = Math.min(10000, (timeoutMs ?? 1000) + 2000);
            const result = await executeGameViewOperation(session.targetId, operationSource(request), transportTimeout, operation !== 'observe');
            throwRuntimeResult(result);
            return result;
        } catch (error) {
            if (error instanceof ToolError) throw error;
            throw new ToolError({ code: 'AUDIO_TRANSPORT_UNAVAILABLE', status: 502,
                message: 'Audio Game View transport failed.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
    }
}
