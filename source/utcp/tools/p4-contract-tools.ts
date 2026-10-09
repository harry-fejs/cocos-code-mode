import { utcpTool } from '../decorators';
import { ToolError } from '../tool-error';
import { ProjectTools } from './project-tools';
import { RuntimeSessionTools } from './runtime-session-tools';

const projectTools = new ProjectTools();
const runtimeTools = new RuntimeSessionTools();

function requireText(value: unknown, name: string, max = 256): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
        throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: `${name} must be a non-empty string of at most ${max} characters.` });
    }
    return value;
}

export class P4ContractTools {
    @utcpTool('physics2dConfigure', 'Configure 2D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '2d', 'configure'])
    async physics2dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path');
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('physics3dConfigure', 'Configure 3D physics project settings only when Creator exposes a verified project settings writer, then query and verify the persisted value.', {
        type: 'object', additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 256 }, value: {} },
        required: ['path', 'value'],
    }, { type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' }, readBack: {} }, required: ['success', 'path', 'readBack'] }, 'POST', ['physics', '3d', 'configure'])
    async physics3dConfigure(args: { path?: string, value?: unknown }): Promise<{ success: boolean, path: string, readBack: unknown }> {
        const path = requireText(args?.path, 'path');
        return projectTools.projectSetConfig({ path, value: args?.value });
    }

    @utcpTool('particlePlayback', 'Control a named runtime particle target only through a verified runtime session; never claims editor-scene playback success.', {
        type: 'object', additionalProperties: false,
        properties: {
            sessionId: { type: 'string', minLength: 1, maxLength: 64 },
            operation: { type: 'string', enum: ['play', 'stop', 'clear'] },
            nodeReference: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'string', minLength: 1, maxLength: 256 } },
                required: ['id'],
            },
        },
        required: ['sessionId', 'operation', 'nodeReference'],
    }, { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] }, 'POST', ['particle', 'playback', 'runtime'])
    async particlePlayback(args: { sessionId?: string, operation?: string, nodeReference?: { id?: string } }): Promise<{ success: true, sessionId: string, operation: string, nodeReference: { id: string }, state: Record<string, unknown> }> {
        const sessionId = requireText(args?.sessionId, 'sessionId', 64);
        if (!args?.nodeReference?.id) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'nodeReference.id is required.' });
        }
        if (!['play', 'stop', 'clear'].includes(String(args.operation))) {
            throw new ToolError({ code: 'INVALID_ARGUMENT', status: 400, message: 'operation must be play, stop, or clear.' });
        }
        const session = await runtimeTools.runtimeSessionLifecycle({ operation: 'inspect', sessionId });
        if (session.ready === false) {
            throw new ToolError({ code: 'RUNTIME_SESSION_STOPPED', status: 409, message: `Runtime session is stopped: ${sessionId}`, recovery: 'Attach a new game-view session before particle playback.' });
        }
        let result: unknown;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'ccp3x',
                method: 'particlePlaybackControl',
                args: [args.nodeReference.id, args.operation],
            });
        } catch (error) {
            throw new ToolError({ code: 'PARTICLE_PLAYBACK_FAILED', status: 502, message: 'Particle runtime control failed.', details: { cause: error instanceof Error ? error.message : String(error) } });
        }
        if (!result || typeof result !== 'object' || !('playing' in result) || typeof result.playing !== 'boolean') {
            throw new ToolError({ code: 'INVALID_EDITOR_RESPONSE', status: 502, message: 'Particle runtime control returned invalid state.' });
        }
        return { success: true, sessionId, operation: String(args.operation), nodeReference: { id: args.nodeReference.id }, state: result as Record<string, unknown> };
    }
}
