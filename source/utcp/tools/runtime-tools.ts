import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { setGameViewTimeScale } from '../utils/game-view-transport';
import { RuntimePreviewResult, RuntimeSessionTools } from './runtime-session-tools';

const sessions = new RuntimeSessionTools();
type PreviewArgs = Parameters<RuntimeSessionTools['previewControl']>[0];
type PlaybackArgs = Omit<PreviewArgs, 'operation' | 'targetKind'>;
const playbackProperties = {
    sessionId: { type: 'string', minLength: 1, maxLength: 64 },
    targetId: { type: 'string', minLength: 1, maxLength: 256, description: 'Optional expected Game View scene UUID.' },
    timeoutMs: { type: 'integer', minimum: 100, maximum: 60000 },
} as const;

// Public controls share the session lifecycle's Game View authority and postconditions.
export class RuntimeTools {
    @utcpTool(
        'runtimePause',
        'Pause the actual Game View runtime and verify its paused state.',
        { type: 'object', additionalProperties: false, properties: playbackProperties },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'pause', 'game', 'debug', 'control']
    )
    async runtimePause(args: PlaybackArgs = {}): Promise<{ success: true }> {
        await sessions.previewControl({ ...args, operation: 'pause' });
        return { success: true };
    }

    @utcpTool(
        'runtimeResume',
        'Resume the actual Game View runtime and verify its running state.',
        { type: 'object', additionalProperties: false, properties: playbackProperties },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'resume', 'game', 'debug', 'control']
    )
    async runtimeResume(args: PlaybackArgs = {}): Promise<{ success: true }> {
        await sessions.previewControl({ ...args, operation: 'resume' });
        return { success: true };
    }

    @utcpTool(
        'runtimeSetTimeScale',
        'Set and verify the actual Game View scheduler time scale (0 = frozen, 1 = normal, >1 = fast-forward).',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                scale: { type: 'number', minimum: 0, maximum: 10, description: 'Time scale multiplier (0-10)' },
            },
            required: ['scale'],
        },
        { type: 'object', properties: { success: { type: 'boolean' }, scale: { type: 'number' } }, required: ['success', 'scale'] },
        'POST',
        ['runtime', 'time', 'scale', 'speed', 'slow', 'fast', 'game']
    )
    async runtimeSetTimeScale(args: { scale: number }): Promise<{ success: true, scale: number }> {
        if (!Number.isFinite(args.scale) || args.scale < 0 || args.scale > 10) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'scale must be a finite number from 0 to 10.' });
        }
        const state = await setGameViewTimeScale(args.scale);
        if (!state.running || state.timeScale !== args.scale) {
            throw new ToolError({ code: 'RUNTIME_CONTROL_UNAVAILABLE', status: 409, message: 'Game View did not confirm the requested scheduler time scale.', recovery: 'Inspect Game View before retrying.' });
        }
        return { success: true, scale: state.timeScale };
    }

    @utcpTool(
        'runtimeGetState',
        'Read actual Game View paused state and nullable scheduler/frame metrics. A stopped preview is not ready.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                paused: { type: 'boolean' },
                timeScale: { type: ['number', 'null'] },
                frameCount: { type: ['integer', 'null'], minimum: 0 },
            },
            required: ['paused', 'timeScale', 'frameCount'],
        },
        'GET',
        ['runtime', 'state', 'game', 'status', 'debug']
    )
    async runtimeGetState(): Promise<{ paused: boolean, timeScale: number | null, frameCount: number | null }> {
        const result = await sessions.previewControl({ operation: 'state' });
        if (!result.state) throw new ToolError({ code: 'RUNTIME_NOT_READY', status: 409, message: 'Creator Game View preview is stopped.', recovery: 'Start Game View before reading runtime metrics.' });
        const { paused, timeScale, frameCount } = result.state;
        return { paused, timeScale, frameCount };
    }

    @utcpTool(
        'runtimePreviewControl',
        'Control the actual Creator Game View lifecycle with verified state and optional session/scene identity. Browser and simulator transports are unsupported.',
        {
            type: 'object',
            additionalProperties: false,
            properties: {
                operation: { type: 'string', enum: ['start', 'pause', 'resume', 'stop', 'step', 'state'] },
                ...playbackProperties,
            },
            required: ['operation'],
        },
        {
            type: 'object',
            properties: {
                success: { type: 'boolean' },
                operation: { type: 'string' },
                session: { type: 'object' },
                state: {
                    type: 'object',
                    properties: {
                        running: { type: 'boolean' },
                        paused: { type: 'boolean' },
                        timeScale: { type: ['number', 'null'] },
                        frameCount: { type: ['integer', 'null'], minimum: 0 },
                        sceneUuid: { type: 'string' },
                    },
                    required: ['running', 'paused', 'timeScale', 'frameCount', 'sceneUuid'],
                },
                preview: { type: 'object' },
                ready: { type: 'boolean' },
            },
            required: ['success', 'operation', 'preview', 'ready'],
        },
        'POST',
        ['runtime', 'session', 'preview', 'start', 'stop', 'pause', 'resume', 'step', 'state']
    )
    async runtimeSessionManage(args: PreviewArgs): Promise<RuntimePreviewResult> {
        return sessions.previewControl(args);
    }
}
