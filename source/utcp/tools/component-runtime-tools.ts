import { JsonSchema } from '@utcp/sdk';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import {
    executeComponentOperation,
    requireComponentText,
    validateComponentTarget,
    ComponentOperation,
} from '../utils/game-view-components';
import { GraphVariableWaitCondition, waitForGraphVariable } from '../graph-variable-wait';

const targetProperties: Record<string, JsonSchema> = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    nodeReference: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', minLength: 1, maxLength: 256 } }, required: ['id'] },
    componentId: { type: 'string', minLength: 1, maxLength: 256 },
};
const animationStateSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: { playing: { type: 'boolean' }, paused: { type: 'boolean' }, time: { type: ['number', 'null'] }, duration: { type: ['number', 'null'] }, speed: { type: ['number', 'null'] } },
    required: ['playing', 'paused', 'time', 'duration', 'speed'],
};
const componentOutputSchema: JsonSchema = {
    type: 'object', additionalProperties: false,
    properties: {
        success: { type: 'boolean', enum: [true] }, sessionId: { type: 'string' }, targetId: { type: 'string' }, operation: { type: 'string' },
        nodeReference: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, nodeUuid: { type: 'string' }, componentId: { type: 'string' },
        componentType: { type: 'string' }, clipName: { type: 'string' }, clipUuid: { type: 'string' }, state: animationStateSchema, events: { type: 'array', maxItems: 100 }, reason: { type: 'string' },
        graphUuid: { type: ['string', 'null'] }, variables: { type: 'array', maxItems: 64 }, layers: { type: 'array', maxItems: 16 },
    }, required: ['success', 'sessionId', 'targetId', 'operation', 'nodeReference', 'nodeUuid', 'componentId'],
};

type BaseArgs = { sessionId?: string; nodeReference?: { id?: string }; componentId?: string; timeoutMs?: number };
type SkeletalArgs = BaseArgs & { operation?: string; clipName?: string; clipUuid?: string };
type EventArgs = BaseArgs & { clipName?: string; clipUuid?: string; maxEvents?: number; timeoutMs?: number };
type GraphVariable = { name?: string; type?: string; value?: number | boolean };
type GraphArgs = BaseArgs & { operation?: string; variable?: GraphVariable; timeoutMs?: number };

function validateTimeout(value: unknown, name = 'timeoutMs'): number {
    if (value === undefined) return 1000;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 3000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be an integer from 100 to 3000.` });
    return value;
}
function validateSkeletal(args: SkeletalArgs, operation: string): ComponentOperation {
    validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
    requireComponentText(args.clipName, 'clipName');
    requireComponentText(args.clipUuid, 'clipUuid');
    if (!['play', 'pause', 'resume', 'stop', 'observe'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, pause, resume, stop, or observe.' });
    return { kind: 'skeletal', operation, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) };
}

export class ComponentRuntimeTools {
    @utcpTool('animationPlaybackObserve', 'Read one exact Animation/SkeletalAnimation clip state in attached Creator3.7 Game View. No playback calls, event listeners or edit-scene substitution. Spine/DragonBones unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'observe', 'runtime', 'read-only'])
    async animationPlaybackObserve(args: SkeletalArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName'); requireComponentText(args.clipUuid, 'clipUuid');
        return executeComponentOperation({ kind: 'animation', operation: 'observe', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) });
    }

    @utcpTool('animationPlaybackControl', 'Control one exact Animation/SkeletalAnimation component and clip in attached Creator3.7 Game View through finite play/pause/resume/stop with actual state read-back. Component pause/resume/stop affect its active states, not an isolated clip. No edit-scene substitution or automatic replay.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'] }, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'operation', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'playback', 'control', 'runtime'])
    async animationPlaybackControl(args: SkeletalArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName'); requireComponentText(args.clipUuid, 'clipUuid');
        if (!['play', 'pause', 'resume', 'stop'].includes(args.operation ?? '')) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, pause, resume or stop.' });
        return executeComponentOperation({ kind: 'animation', operation: args.operation!, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) });
    }

    @utcpTool('skeletalAnimationPlay', 'Play, pause, resume, stop or observe one exact cc.SkeletalAnimation clip in Game View. observe is read-only; Spine and DragonBones are unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop', 'observe'] }, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'operation', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['skeletal', 'animation', 'playback', 'runtime'])
    async skeletalAnimationPlay(args: SkeletalArgs): Promise<Record<string, unknown>> {
        const operation = args?.operation;
        if (typeof operation !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation is required.' });
        return executeComponentOperation(validateSkeletal(args, operation));
    }

    @utcpTool('skeletalAnimationWaitForState', 'Poll one exact SkeletalAnimation clip state without changing playback. Missing metrics/invalidated targets fail closed; caller deadline bounds each observation.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, playing: { type: 'boolean' }, paused: { type: 'boolean' }, minTime: { type: 'number', minimum: 0, maximum: 3600 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000, default: 3000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000, default: 100 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, { type: 'object', properties: { matched: { type: 'boolean' }, timedOut: { type: 'boolean' }, observations: { type: 'integer' }, state: animationStateSchema }, required: ['matched', 'timedOut', 'observations', 'state'] }, 'POST', ['skeletal', 'animation', 'wait', 'read-only'])
    async skeletalAnimationWaitForState(args: SkeletalArgs & { playing?: boolean; paused?: boolean; minTime?: number; pollMs?: number }) {
        const timeoutMs = args?.timeoutMs ?? 3000; const pollMs = args?.pollMs ?? 100;
        if (args.playing === undefined && args.paused === undefined && args.minTime === undefined
            || args.playing !== undefined && typeof args.playing !== 'boolean' || args.paused !== undefined && typeof args.paused !== 'boolean'
            || args.minTime !== undefined && (typeof args.minTime !== 'number' || !Number.isFinite(args.minTime) || args.minTime < 0 || args.minTime > 3600)
            || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(pollMs) || pollMs < 25 || pollMs > 1000) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'Provide bounded state conditions, timeout and poll interval.' });
        const deadline = Date.now() + timeoutMs; let observations = 0;
        for (;;) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Skeletal state observation deadline expired.' });
            const operation = validateSkeletal({ ...args, timeoutMs: Math.max(100, Math.min(remaining, 1000)) }, 'observe');
            let timer: NodeJS.Timeout | undefined; let result: Record<string, unknown>;
            try { result = await Promise.race([executeComponentOperation(operation), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ToolError({ code: 'RUNTIME_STATE_TIMEOUT', status: 409, message: 'Skeletal state read exceeded caller deadline; no playback mutation dispatched.' })), remaining); })]); }
            finally { clearTimeout(timer); }
            const state = result.state as { playing?: unknown; paused?: unknown; time?: unknown } | undefined;
            if (!state || typeof state.playing !== 'boolean' || typeof state.paused !== 'boolean') throw new ToolError({ code: 'INVALID_RUNTIME_RESPONSE', status: 502, message: 'Invalid skeletal state observation.' });
            if (args.minTime !== undefined && (typeof state.time !== 'number' || !Number.isFinite(state.time))) throw new ToolError({ code: 'UNSUPPORTED_RUNTIME_METRIC', status: 422, message: 'Skeletal clip time is unavailable.' });
            observations++;
            const matched = (args.playing === undefined || args.playing === state.playing) && (args.paused === undefined || args.paused === state.paused) && (args.minTime === undefined || (state.time as number) >= args.minTime);
            if (matched || Date.now() >= deadline) return { matched, timedOut: !matched, observations, state };
            await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
        }
    }

    @utcpTool('skeletalAnimationEvents', 'Observe bounded cc.SkeletalAnimation lifecycle events for one exact clip, with deadline and listener cleanup. Spine and DragonBones are unsupported.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['skeletal', 'animation', 'events', 'runtime'])
    async skeletalAnimationEvents(args: EventArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        requireComponentText(args.clipName, 'clipName');
        requireComponentText(args.clipUuid, 'clipUuid');
        if (args.maxEvents !== undefined && (!Number.isInteger(args.maxEvents) || args.maxEvents < 1 || args.maxEvents > 100)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxEvents must be an integer from 1 to 100.' });
        const op: ComponentOperation = { kind: 'events', operation: 'observe', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, maxEvents: args.maxEvents ?? 20, timeoutMs: validateTimeout(args.timeoutMs) };
        return executeComponentOperation(op);
    }

    @utcpTool('animationPlaybackEvents', 'Observe bounded Animation/SkeletalAnimation lifecycle events for one exact Game View clip. Read-only playback observation with listener cleanup; no event history before registration or automatic playback dispatch.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, maxEvents: { type: 'integer', minimum: 1, maximum: 100 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['animation', 'events', 'runtime', 'read-only'])
    async animationPlaybackEvents(args: EventArgs): Promise<Record<string, unknown>> {
        const operation = validateSkeletal(args, 'observe');
        if (args.maxEvents !== undefined && (!Number.isInteger(args.maxEvents) || args.maxEvents < 1 || args.maxEvents > 100)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'maxEvents must be an integer from1 to100.' });
        return executeComponentOperation({ ...operation, kind: 'events', maxEvents: args.maxEvents ?? 20 });
    }

    @utcpTool('animationGraphPreview', 'Inspect one exact cc.animation.AnimationController runtime graph, or set one typed FLOAT/INTEGER/BOOLEAN variable with read-back. No dynamic methods or invented graph component are used.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['inspect', 'setVariable'] }, variable: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: ['float', 'integer', 'boolean'] }, value: {} }, required: ['name', 'type', 'value'] }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'operation'],
    }, componentOutputSchema, 'POST', ['animation', 'graph', 'preview', 'runtime'])
    async animationGraphPreview(args: GraphArgs): Promise<Record<string, unknown>> {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        if (args.operation !== 'inspect' && args.operation !== 'setVariable') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be inspect or setVariable.' });
        let variable: ComponentOperation['variable'];
        if (args.operation === 'setVariable') {
            const candidate = args.variable;
            if (!candidate || typeof candidate !== 'object') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable is required.' });
            requireComponentText(candidate.name, 'variable.name');
            if (candidate.type !== 'float' && candidate.type !== 'integer' && candidate.type !== 'boolean') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable.type must be float, integer, or boolean.' });
            if (candidate.type === 'boolean' ? typeof candidate.value !== 'boolean' : typeof candidate.value !== 'number' || !Number.isFinite(candidate.value) || candidate.type === 'integer' && !Number.isInteger(candidate.value)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'variable.value must match its declared finite type.' });
            const variableType: 'float' | 'integer' | 'boolean' = candidate.type;
            const variableValue: number | boolean = candidate.value as number | boolean;
            variable = { name: candidate.name, type: variableType, value: variableValue };
        }
        return executeComponentOperation({ kind: 'graph', operation: args.operation, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, variable, timeoutMs: validateTimeout(args.timeoutMs) });
    }

    @utcpTool('animationGraphWaitForVariable', 'Observe one exact runtime graph variable until a typed value matches. Exact graph UUID required; inspect-only, no setValue or runtime restart. Target drift/missing/type/deadline errors fail closed.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, graphUuid: { type: 'string', minLength: 1, maxLength: 256 }, name: { type: 'string', minLength: 1, maxLength: 256 }, type: { type: 'string', enum: ['float', 'integer', 'boolean'] }, value: {}, timeoutMs: { type: 'integer', minimum: 100, maximum: 10000 }, pollMs: { type: 'integer', minimum: 25, maximum: 1000 } }, required: ['sessionId', 'nodeReference', 'componentId', 'graphUuid', 'name', 'type', 'value'],
    }, { type: 'object', properties: { matched: { type: 'boolean', const: true }, observations: { type: 'integer' }, graphUuid: { type: 'string' }, variable: { type: 'object' }, writes: { type: 'boolean', const: false } }, required: ['matched', 'observations', 'graphUuid', 'variable', 'writes'] }, 'POST', ['animation', 'graph', 'wait', 'read-only'])
    async animationGraphWaitForVariable(args: BaseArgs & GraphVariableWaitCondition) {
        validateComponentTarget({ sessionId: args?.sessionId ?? '', nodeReference: { id: args?.nodeReference?.id ?? '' }, componentId: args?.componentId }, true);
        return waitForGraphVariable(args, timeoutMs => executeComponentOperation({ kind: 'graph', operation: 'inspect', sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, timeoutMs }));
    }
}
