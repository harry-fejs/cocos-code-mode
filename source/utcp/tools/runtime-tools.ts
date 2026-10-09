import { utcpTool } from '../decorators';

// Runtime control tools — pause/resume game loop, adjust time scale, query state.
// Delegates to scene.ts handlers via execute-scene-script for actual cc.* access.

export class RuntimeTools {

    @utcpTool(
        'runtimePause',
        'Pause the game runtime (stops update loop). Use for inspection or step-by-step debugging.',
        { type: 'object', properties: {} },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'pause', 'game', 'debug', 'control']
    )
    async runtimePause(): Promise<{ success: boolean }> {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x', method: 'runtimePause', args: [],
        });
        return { success: result === true };
    }

    @utcpTool(
        'runtimeResume',
        'Resume the game runtime after pause.',
        { type: 'object', properties: {} },
        { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] },
        'POST',
        ['runtime', 'resume', 'game', 'debug', 'control']
    )
    async runtimeResume(): Promise<{ success: boolean }> {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x', method: 'runtimeResume', args: [],
        });
        return { success: result === true };
    }

    @utcpTool(
        'runtimeSetTimeScale',
        'Set the game time scale (0 = frozen, 1 = normal, >1 = fast-forward). Affects scheduler and tweens.',
        {
            type: 'object',
            properties: {
                scale: { type: 'number', minimum: 0, maximum: 10, description: 'Time scale multiplier (0-10)' },
            },
            required: ['scale'],
        },
        { type: 'object', properties: { success: { type: 'boolean' }, scale: { type: 'number' } }, required: ['success'] },
        'POST',
        ['runtime', 'time', 'scale', 'speed', 'slow', 'fast', 'game']
    )
    async runtimeSetTimeScale(args: { scale: number }): Promise<{ success: boolean, scale: number }> {
        if (!Number.isFinite(args.scale)) {
            throw new Error('runtimeSetTimeScale requires a finite number');
        }
        const scale = Math.max(0, Math.min(args.scale, 10));
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x', method: 'runtimeSetTimeScale', args: [scale],
        });
        return { success: result === true, scale };
    }

    @utcpTool(
        'runtimeGetState',
        'Get current runtime state: paused, time scale, frame count.',
        { type: 'object', properties: {} },
        {
            type: 'object',
            properties: {
                paused: { type: 'boolean' },
                timeScale: { type: 'number' },
                frameCount: { type: 'number' },
            },
            required: ['paused'],
        },
        'GET',
        ['runtime', 'state', 'game', 'status', 'debug']
    )
    async runtimeGetState(): Promise<{ paused: boolean, timeScale: number, frameCount: number }> {
        const result = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'ccp3x', method: 'runtimeGetState', args: [],
        }) as any;
        if (!result || typeof result !== 'object') throw new Error('runtimeGetState: no runtime state — is the preview/game running?');
        // Reject partial payloads outright: field-level coercion would fabricate
        // false/1/0 again — the exact false-success class this audit removes (docs §2).
        if (typeof result.paused !== 'boolean' || typeof result.timeScale !== 'number' || typeof result.frameCount !== 'number') {
            throw new Error(`runtimeGetState: malformed runtime payload ${JSON.stringify(result).slice(0, 160)}`);
        }
        return { paused: result.paused, timeScale: result.timeScale, frameCount: result.frameCount };
    }
}
