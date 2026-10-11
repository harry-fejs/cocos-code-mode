import { JsonSchema } from '@utcp/sdk';
import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import {
    executeComponentOperation,
    requireComponentText,
    validateComponentTarget,
    ComponentOperation,
} from '../utils/game-view-components';

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
    if (!['play', 'pause', 'resume', 'stop'].includes(operation)) throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, pause, resume, or stop.' });
    return { kind: 'animation', operation, sessionId: args.sessionId!, nodeReference: { id: args.nodeReference!.id! }, componentId: args.componentId!, clipName: args.clipName!, clipUuid: args.clipUuid!, timeoutMs: validateTimeout(args.timeoutMs) };
}

export class ComponentRuntimeTools {
    @utcpTool('skeletalAnimationPlay', 'Play, pause, resume, or stop one exact cc.SkeletalAnimation clip in the active Game View. Spine and DragonBones are unsupported and fail closed.', {
        type: 'object', additionalProperties: false, properties: { ...targetProperties, operation: { type: 'string', enum: ['play', 'pause', 'resume', 'stop'] }, clipName: { type: 'string', minLength: 1, maxLength: 256 }, clipUuid: { type: 'string', minLength: 1, maxLength: 256 }, timeoutMs: { type: 'integer', minimum: 100, maximum: 3000 } },
        required: ['sessionId', 'nodeReference', 'componentId', 'operation', 'clipName', 'clipUuid'],
    }, componentOutputSchema, 'POST', ['skeletal', 'animation', 'playback', 'runtime'])
    async skeletalAnimationPlay(args: SkeletalArgs): Promise<Record<string, unknown>> {
        const operation = args?.operation;
        if (typeof operation !== 'string') throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation is required.' });
        return executeComponentOperation(validateSkeletal(args, operation));
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
}
